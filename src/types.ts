// Shared types for the entire pipeline.

/**
 * Graylog / GELF message as delivered by the logging stack.
 * Most fields are already structured — we lift them into `Event`
 * directly and only apply the message-parser to the inner `message`.
 */
export interface MessageContent {
  container: string;
  component?: string;
  tenant_id: string;
  pod: string;
  gl2_remote_ip: string;
  gl2_remote_port: number;
  source: string;
  gl2_source_input: string;
  docker: string;
  protocol: number;
  hostname: string;
  log_type: string;
  du_stream_id?: string;
  gl2_source_node: string;
  tag: string;
  class: string;
  timestamp: string;
  gl2_accounted_message_size: number;
  level: number;
  streams: string[] | [];
  gl2_message_id: string;
  thread: string;
  message: string;
  labels: string;
  namespace: string;
  _id: string;
  time: string;
  kubernetes_host: string;
  facility: string;
  request_id: string;
}

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
  /**
   * Virtualize-resolved peer (the "other side" of the conversation).
   * Populated during virtualization when we can identify the target —
   * either an internal container whose host appears in the URL, or an
   * external host. Null if the event has no URL and no receiver.
   */
  resolvedPeer: string | null;
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

/**
 * Classification of a node on the diagram.
 *   container — actually logged itself (direct evidence from `container=...`)
 *   external  — third-party URL host; we only see it from a container's POV
 *   virtual   — inferred from sender/receiver, no direct logs from it
 *   client    — synthetic "outside caller" (no known service initiated a call)
 *   unknown   — last-resort fallback
 */
export type ServiceKind = "container" | "external" | "virtual" | "client" | "unknown";

export interface ServiceNode {
  /** Stable identifier used verbatim in edge.from/to. */
  name: string;
  kind: ServiceKind;
  /** For kind=external: the URL host (e.g. "api.stripe.com"). */
  host?: string;
}

/** Final result returned by the pipeline. */
export interface Trace {
  /** Trace-level identifier — one per pipeline invocation. */
  requestId: string;
  edges: PublicEdge[];
  /** Every node referenced by any edge, in first-seen order. */
  services: ServiceNode[];
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
