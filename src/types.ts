// Shared types for the entire pipeline.

/**
 * Graylog / GELF message as delivered by the logging stack.
 * Only `message` is strictly required — every other field may be missing
 * in practice, so all are optional. The adapter picks the best source for
 * each slot it cares about (see `deriveContainer` in adapters/graylog.ts).
 *
 * Both snake_case (`request_id`) and camelCase (`requestId`) correlation-id
 * variants are supported — different log pipelines emit different casings.
 */
export interface MessageContent {
  message: string;

  // Service identification (adapter tries these in order)
  container?: string;
  component?: string;
  service?: string;
  pod?: string;
  source?: string;
  hostname?: string;

  // Correlation IDs
  request_id?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  tenant_id?: string;

  // Time
  timestamp?: string;
  time?: string;

  // Severity (0–7 syslog)
  level?: number;

  // Everything else — Graylog stuffs dozens of fields we ignore.
  [extra: string]: unknown;
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
  /**
   * True when correlate paired this event with a counterpart on the
   * other side of a cross-service hop. Currently set only for INs
   * that are paired with a caller's OUT (same requestId). When true,
   * stack.ts suppresses this event's REQUEST edge (the OUT already
   * emitted the logical edge) and skips INFERRED_RESPONSE emission
   * if backtracking walks past this frame.
   */
  isPaired: boolean;
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
  /** requestId of the source event — used for cross-side dedup. */
  requestId: string | null;
}

/**
 * A pending REQUEST waiting on a RESPONSE. Lives on the matcher's stack.
 *
 * `edge` is null for "root" entry frames — IN events without an
 * identifiable sender when `includeClient: false`. They still take a
 * stack slot so response-matching and sibling detection work, but no
 * visible edge is drawn on the diagram.
 */
export interface StackFrame {
  ev: Event;
  edge: Edge | null;
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
  /**
   * Whether to emit a synthetic `client` node for entry/exit edges of IN
   * events that have no identifiable sender. Default: false.
   *
   * With `false` (default): the first service in the trace is treated as
   * the entry point; no phantom caller appears on the diagram. Unresolved
   * root REQUESTs are silently dropped.
   *
   * With `true`: matches spec §10 case 1 — `client → api → ... → api → client`.
   */
  includeClient?: boolean;
}

export interface DebugTrace {
  graph: Trace;
  events: Event[];
}
