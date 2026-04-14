// Graph builder — converts rich internal edges into the final public Trace.
//
//   {
//     requestId,                          // trace-level id (one per pipeline run)
//     edges:    [{ from, to, message, type }, ...],
//     services: [unique nodes in first-seen order],
//     confidence,
//     parallel?: true
//   }

import type { Edge, Event, PublicEdge, StackFrame, Trace } from "./types.ts";

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
}

export function buildGraph({ edges, unresolved, events }: BuildGraphInput): Trace {
  const closedEdges = edges.slice();
  // Close unresolved frames so the graph is never "open" — spec §12.
  for (const frame of unresolved) {
    closedEdges.push({
      from: frame.edge.to,
      to: frame.edge.from,
      type: "INFERRED_RESPONSE",
      message: null,
      container: frame.ev.container,
      timestamp: frame.ev.timestamp,
      confidence: 0.4,
      evidence: [frame.ev.id],
    });
  }

  const publicEdges: PublicEdge[] = closedEdges.map((e) => ({
    from: e.from,
    to: e.to,
    message: e.message,
    type: e.type,
  }));

  const services = collectServices(closedEdges);
  const confidence = aggregateConfidence(closedEdges);
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

function collectServices(edges: readonly Edge[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const e of edges) {
    for (const node of [e.from, e.to]) {
      if (node && !seen.has(node)) {
        seen.add(node);
        order.push(node);
      }
    }
  }
  return order;
}

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
