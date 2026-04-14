// Shared types for the entire pipeline.
//
// Naming conventions:
//   `Raw*`         — output of stage 1 (line-level parsing)
//   `Event`        — fully normalized + classified event (stages 2-4)
//   `Edge`         — internal rich edge with confidence/evidence
//   `PublicEdge`   — slim edge exposed in the final result
//   `Trace`        — top-level result object returned by the pipeline

export type EventType = "IN" | "OUT" | "RESPONSE" | "UNKNOWN";

export type EdgeType =
  | "REQUEST"
  | "RESPONSE"
  | "INFERRED_REQUEST"
  | "INFERRED_RESPONSE"
  | "UNKNOWN";

/** Output of Stage 1 — line-level parser. */
export interface RawEvent {
  timestamp: number | null;
  level: string | null;
  container: string | null;
  message: string;
  raw: string;
  lineNo: number;
}

/** Output of stages 2–4 — the canonical event used by the matching engine. */
export interface Event {
  id: string;
  timestamp: number | null;
  service: string;
  container: string | null;
  type: EventType;
  method: string | null;
  url: string | null;
  status: number | null;
  sender: string | null;
  receiver: string | null;
  /** Correlation ID extracted from the log itself (NOT the trace-level id). */
  requestId: string | null;
  message: string;
  raw: string;
  lineNo: number;
}

/** Internal representation of an edge while it's being built. */
export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  message: string | null;
  container: string | null;
  timestamp: number | null;
  confidence: number;
  evidence: string[];
}

/** A pending REQUEST waiting on a RESPONSE. Lives on the matcher's stack. */
export interface StackFrame {
  ev: Event;
  edge: Edge;
}

/** Public, slim edge — the shape consumers render on a diagram. */
export interface PublicEdge {
  from: string;
  to: string;
  message: string | null;
  type: EdgeType;
}

/** Final result returned by the pipeline. */
export interface Trace {
  /** Trace-level identifier — one per pipeline invocation. */
  requestId: string;
  edges: PublicEdge[];
  /** Every node referenced by any edge, in first-seen order. */
  services: string[];
  /** Mean confidence across all edges, in [0, 1]. */
  confidence: number;
  parallel?: true;
}

export interface PipelineOptions {
  debug?: boolean;
}

export interface DebugTrace {
  graph: Trace;
  events: Event[];
}
