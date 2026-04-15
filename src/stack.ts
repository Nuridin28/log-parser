// Core algorithm (spec §8) — stack with backtracking + fan-out awareness.
//
// For every REQUEST we push a frame. For every RESPONSE we search the stack
// for the best-scoring match. Frames above the match that share the same
// *caller* as the match are siblings (fan-out, parallel) — they stay on the
// stack. Frames that do NOT share the caller are considered skipped and are
// closed with INFERRED_RESPONSE edges (backtracking, case 3).

import type { Edge, Event, StackFrame } from "./types.ts";
import { bestMatch } from "./matcher.ts";
import { peerOf } from "./virtualize.ts";

const CLIENT = "client";

export interface BuildResult {
  edges: Edge[];
  unresolved: StackFrame[];
}

export interface BuildOptions {
  includeClient?: boolean;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeEdge(args: {
  from: string;
  to: string;
  type: Edge["type"];
  ev: Event | null;
  confidence: number;
  evidence?: string[];
}): Edge {
  return {
    from: args.from,
    to: args.to,
    type: args.type,
    message: args.ev?.message ?? null,
    container: args.ev?.container ?? null,
    timestamp: args.ev?.timestamp ?? null,
    confidence: round(args.confidence),
    evidence: args.evidence ?? [],
    requestId: args.ev?.requestId ?? null,
  };
}

function baseConfidence(ev: Event): number {
  let c = 0.6;
  if (ev.requestId) c += 0.15;
  if (ev.sender && ev.receiver) c += 0.1;
  if (ev.url) c += 0.05;
  if (ev.method) c += 0.05;
  if (ev.status != null) c += 0.05;
  return Math.min(1, c);
}

export function buildEdges(events: readonly Event[], opts: BuildOptions = {}): BuildResult {
  const includeClient = opts.includeClient ?? false;
  const edges: Edge[] = [];
  const stack: StackFrame[] = [];

  for (const ev of events) {
    if (ev.type === "IN" || ev.type === "OUT") {
      const edge = handleRequest(ev, edges, includeClient);
      // Root frames (edge=null) still occupy a stack slot so sibling
      // detection and response matching keep working.
      stack.push({ ev, edge });
    } else if (ev.type === "RESPONSE") {
      handleResponse(ev, stack, edges, includeClient);
    }
    // UNKNOWN events are intermediate/trace-only — skip.
  }

  return { edges, unresolved: stack };
}

function handleRequest(ev: Event, edges: Edge[], includeClient: boolean): Edge | null {
  let from: string | null;
  let to: string;
  if (ev.type === "IN") {
    from = ev.sender ?? (includeClient ? CLIENT : null);
    to = ev.service;
  } else {
    from = ev.service;
    to = ev.receiver ?? peerOf(ev) ?? "unknown";
  }
  if (from == null) return null; // root entry — no visible edge
  const edge = makeEdge({
    from,
    to,
    type: "REQUEST",
    ev,
    confidence: baseConfidence(ev),
    evidence: [ev.id],
  });
  // A paired IN describes the same logical call as its counterpart OUT.
  // We still create the edge (for response-direction bookkeeping on the
  // frame) but do NOT emit it — the OUT's emission is the authoritative
  // one for the diagram.
  if (!ev.isPaired) edges.push(edge);
  return edge;
}

function handleResponse(
  ev: Event,
  stack: StackFrame[],
  edges: Edge[],
  includeClient: boolean,
): void {
  if (stack.length === 0) {
    // No open request to match — synthesize an INFERRED_REQUEST (Case 2).
    // If we can't identify a plausible caller, we only keep the RESPONSE
    // from the responder's perspective; no phantom `client` node is added
    // unless includeClient is on.
    const responder = ev.service;
    const caller = ev.receiver ?? ev.sender ?? peerOf(ev) ?? (includeClient ? CLIENT : null);
    if (caller == null) return; // no one to respond to — drop
    edges.push(
      makeEdge({
        from: caller,
        to: responder,
        type: "INFERRED_REQUEST",
        ev,
        confidence: 0.5,
        evidence: [ev.id],
      }),
    );
    edges.push(
      makeEdge({
        from: responder,
        to: caller,
        type: "RESPONSE",
        ev,
        confidence: baseConfidence(ev) * 0.9,
        evidence: [ev.id],
      }),
    );
    return;
  }

  const candidates = stack.map((f) => f.ev);
  const { match, score: s } = bestMatch(ev, candidates, { min: 0.1 });

  let matchIndex = match ? candidates.indexOf(match) : -1;
  if (matchIndex === -1) matchIndex = stack.length - 1;

  const matched = stack[matchIndex]!;
  const matchedCaller = matched.ev.service;
  const preserved: StackFrame[] = [];
  for (let i = stack.length - 1; i > matchIndex; i--) {
    const upper = stack[i]!;
    if (upper.ev.service === matchedCaller) {
      preserved.unshift(upper);
    } else if (upper.edge && !upper.ev.isPaired) {
      // Skipped: emit INFERRED_RESPONSE back to its caller. Paired INs
      // are silently dropped — their logical edge is already represented
      // by the paired OUT's RESPONSE half.
      edges.push(
        makeEdge({
          from: upper.edge.to,
          to: upper.edge.from,
          type: "INFERRED_RESPONSE",
          ev: upper.ev,
          confidence: 0.6,
          evidence: [upper.ev.id],
        }),
      );
    }
    // Root frames with no edge are silently dropped.
  }

  // Emit RESPONSE edge only if the matched frame had a visible REQUEST edge.
  if (matched.edge) {
    edges.push(
      makeEdge({
        from: matched.edge.to,
        to: matched.edge.from,
        type: "RESPONSE",
        ev,
        confidence: Math.max(0.5, s),
        evidence: [matched.ev.id, ev.id],
      }),
    );
  }

  stack.length = matchIndex;
  for (const sib of preserved) stack.push(sib);
}
