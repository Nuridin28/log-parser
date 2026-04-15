// Graph builder — converts rich internal edges into the final public Trace.
//
//   {
//     requestId,                          // trace-level id (one per pipeline run)
//     edges:    [{ from, to, message, type }, ...],
//     services: [unique nodes in first-seen order],
//     confidence,
//     parallel?: true
//   }

import type { Edge, Event, PublicEdge, ServiceKind, ServiceNode, StackFrame, Trace } from "./types.ts";
import { EXTERNAL_PREFIX, UNKNOWN_PREFIX, VIRTUAL_PREFIX } from "./virtualize.ts";

let REQUEST_ID = 0;
function nextRequestId(): string {
  REQUEST_ID += 1;
  return `r${REQUEST_ID}`;
}
export function resetRequestIds(): void {
  REQUEST_ID = 0;
}

export interface BuildGraphInput {
  edges: Edge[];
  unresolved: StackFrame[];
  events: readonly Event[];
  includeClient?: boolean;
}

export function buildGraph({
  edges,
  unresolved,
  events,
  includeClient = false,
}: BuildGraphInput): Trace {
  const closedEdges = edges.slice();
  // Close unresolved frames so the graph is never "open" — spec §12.
  for (const frame of unresolved) {
    // Root frames (no visible REQUEST edge) are entry points with nowhere
    // to return to; we only close them if includeClient explicitly asks
    // for the synthetic `client` lifeline.
    if (!frame.edge) continue;
    if (frame.ev.isPaired) continue; // paired IN — its edge is already represented by the OUT side
    if (!includeClient && frame.edge.from === "client") continue;
    closedEdges.push({
      from: frame.edge.to,
      to: frame.edge.from,
      type: "INFERRED_RESPONSE",
      message: null,
      container: frame.ev.container,
      timestamp: frame.ev.timestamp,
      confidence: 0.4,
      evidence: [frame.ev.id],
      requestId: frame.ev.requestId,
    });
  }

  // Dedupe edges that describe the same cross-service call from both
  // sides. When correlate pairs an OUT (from caller) with an IN (on
  // callee), both produce a `caller → callee` REQUEST edge. We fold them
  // into one, keeping the richer message (or the higher-confidence one).
  const deduped = dedupeEdges(closedEdges);

  const publicEdges: PublicEdge[] = deduped.map((e) => ({
    from: e.from,
    to: e.to,
    message: e.message,
    type: e.type,
  }));

  const services = collectServices(deduped);
  const confidence = aggregateConfidence(deduped);
  const parallel = detectParallel(events);

  const trace: Trace = {
    requestId: nextRequestId(),
    edges: publicEdges,
    services,
    confidence: round(confidence),
  };
  if (parallel) trace.parallel = true;
  return trace;
}

function classifyNode(name: string): ServiceNode {
  if (name === "client") return { name, kind: "client" };
  if (name.startsWith(EXTERNAL_PREFIX)) {
    return { name, kind: "external", host: name.slice(EXTERNAL_PREFIX.length) };
  }
  if (name.startsWith(VIRTUAL_PREFIX)) return { name, kind: "virtual" };
  if (name.startsWith(UNKNOWN_PREFIX)) return { name, kind: "unknown" };
  return { name, kind: "container" };
}

function collectServices(edges: readonly Edge[]): ServiceNode[] {
  const seen = new Set<string>();
  const order: ServiceNode[] = [];
  for (const e of edges) {
    for (const node of [e.from, e.to]) {
      if (node && !seen.has(node)) {
        seen.add(node);
        order.push(classifyNode(node));
      }
    }
  }
  return order;
}

// Re-export so callers can satisfy the compiler without importing from types.
export type { ServiceKind };

function aggregateConfidence(edges: readonly Edge[]): number {
  if (edges.length === 0) return 0;
  const sum = edges.reduce((s, e) => s + e.confidence, 0);
  return sum / edges.length;
}

function detectParallel(events: readonly Event[]): boolean {
  const openBy = new Map<string, number>();
  let sawOverlap = false;
  for (const ev of events) {
    if (ev.type === "OUT") {
      const n = (openBy.get(ev.service) ?? 0) + 1;
      openBy.set(ev.service, n);
      if (n >= 2) sawOverlap = true;
    } else if (ev.type === "RESPONSE") {
      const key = ev.receiver ?? ev.service;
      const n = (openBy.get(key) ?? 1) - 1;
      if (n <= 0) openBy.delete(key);
      else openBy.set(key, n);
    }
  }
  return sawOverlap;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Collapse edges that describe the same logical call from two sides.
 *
 * Two edges merge iff:
 *   - identical from, to, and type, AND
 *   - both carry a non-null `requestId`, AND
 *   - those requestIds are equal.
 *
 * The `requestId` check is what makes this safe — two unrelated calls
 * (e.g. two sequential calls to api.stripe.com) have distinct source
 * events whose requestIds differ (or are null), so they are NOT merged.
 * Only events that share a correlation ID, which means they are the
 * OUT and IN sides of the same cross-service hop, get folded together.
 *
 * On merge we keep the edge with the higher confidence / richer message,
 * and union their evidence lists.
 */
function dedupeEdges(edges: readonly Edge[]): Edge[] {
  const out: Edge[] = [];
  for (const e of edges) {
    if (!e.requestId) {
      out.push(e);
      continue;
    }
    const existing = out.find(
      (x) =>
        x.requestId === e.requestId &&
        x.from === e.from &&
        x.to === e.to &&
        x.type === e.type,
    );
    if (!existing) {
      out.push(e);
      continue;
    }
    const union = [...new Set([...existing.evidence, ...e.evidence])];
    if (preferReplacement(e, existing)) {
      const idx = out.indexOf(existing);
      out[idx] = { ...e, evidence: union, confidence: Math.max(existing.confidence, e.confidence) };
    } else {
      existing.evidence = union;
      existing.confidence = Math.max(existing.confidence, e.confidence);
    }
  }
  return out;
}

function preferReplacement(candidate: Edge, incumbent: Edge): boolean {
  if (candidate.confidence !== incumbent.confidence) {
    return candidate.confidence > incumbent.confidence;
  }
  const cm = candidate.message?.length ?? 0;
  const im = incumbent.message?.length ?? 0;
  return cm > im;
}
