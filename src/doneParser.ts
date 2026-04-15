// doneParser.ts — single-file bundle.
//
// All logic from the parser lives here so consumers can vendor a single
// file into their project and `import { run, fromMessageContent }` without
// worrying about transitive file layout.
//
// Public API:
//   run(input, opts?)              — main entry (accepts string / string[] / RawEvent[])
//   fromMessageContent(messages)   — Graylog MessageContent[] → RawEvent[]
//
// Types:
//   Trace, PublicEdge, ServiceNode, ServiceKind,
//   MessageContent, PipelineOptions, DebugTrace,
//   RawEvent, Event, EventType, EdgeType, Edge, StackFrame

/* ==========================================================================
   TYPES
   ========================================================================== */

export type EventType = "IN" | "OUT" | "RESPONSE" | "UNKNOWN";

export type EdgeType =
  | "REQUEST"
  | "RESPONSE"
  | "INFERRED_REQUEST"
  | "INFERRED_RESPONSE"
  | "UNKNOWN";

export interface RawEvent {
  timestamp: number | null;
  level: string | null;
  container: string | null;
  message: string;
  raw: string;
  lineNo: number;
}

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
  requestId: string | null;
  resolvedPeer: string | null;
  isPaired: boolean;
  message: string;
  raw: string;
  lineNo: number;
}

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  message: string | null;
  container: string | null;
  timestamp: number | null;
  confidence: number;
  evidence: string[];
  requestId: string | null;
}

export interface StackFrame {
  ev: Event;
  edge: Edge | null;
}

export interface PublicEdge {
  from: string;
  to: string;
  message: string | null;
  type: EdgeType;
}

export type ServiceKind = "container" | "external" | "virtual" | "client" | "unknown";

export interface ServiceNode {
  name: string;
  kind: ServiceKind;
  host?: string;
}

export interface Trace {
  requestId: string;
  edges: PublicEdge[];
  services: ServiceNode[];
  confidence: number;
  parallel?: true;
}

export interface PipelineOptions {
  debug?: boolean;
  /** Emit synthetic `client` entry/exit edges. Default false. */
  includeClient?: boolean;
}

export interface DebugTrace {
  graph: Trace;
  events: Event[];
}

export interface MessageContent {
  message: string;
  container?: string;
  component?: string;
  service?: string;
  pod?: string;
  source?: string;
  hostname?: string;
  request_id?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  tenant_id?: string;
  timestamp?: string;
  time?: string;
  level?: number;
  [extra: string]: unknown;
}

/* ==========================================================================
   UTILS — time
   ========================================================================== */

const SHORT_TS_RE = /^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;
const ISO_TS_RE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\]/;

function parseTimestamp(line: string): number | null {
  const iso = line.match(ISO_TS_RE);
  if (iso) {
    const t = Date.parse(iso[1]!);
    return Number.isFinite(t) ? t : null;
  }
  const m = line.match(SHORT_TS_RE);
  if (!m) return null;
  const [, hh, mm, ss, ms = "0"] = m as unknown as [string, string, string, string, string];
  return (
    Number(hh) * 3_600_000 +
    Number(mm) * 60_000 +
    Number(ss) * 1_000 +
    Number(ms.padEnd(3, "0"))
  );
}

function parseInlineIsoTimestamp(message: string): number | null {
  const m = message.match(ISO_TS_RE);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : null;
}

function stripTimestamp(line: string): string {
  return line.replace(ISO_TS_RE, "").replace(SHORT_TS_RE, "").trimStart();
}

/* ==========================================================================
   UTILS — json
   ========================================================================== */

function safeParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function extractJson(message: string): Record<string, unknown> | null {
  const i = message.indexOf("{");
  if (i === -1) return null;
  for (let end = message.length; end > i; end--) {
    const slice = message.slice(i, end);
    const parsed = safeParse(slice);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

/* ==========================================================================
   UTILS — hash (FNV-1a 32-bit)
   ========================================================================== */

function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* ==========================================================================
   STAGE 1 — parser
   ========================================================================== */

const LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"]);
const CONTAINER_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function parseLines(rawLines: readonly string[]): RawEvent[] {
  const events: RawEvent[] = [];
  let lineNo = 0;
  for (const rawLine of rawLines) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;

    const timestamp = parseTimestamp(line);
    let rest = timestamp != null ? stripTimestamp(line) : line;

    let level: string | null = null;
    const firstSpace = rest.indexOf(" ");
    if (firstSpace !== -1) {
      const head = rest.slice(0, firstSpace);
      if (LEVELS.has(head.toUpperCase())) {
        level = head.toUpperCase();
        rest = rest.slice(firstSpace + 1).trimStart();
      }
    }

    let container: string | null = null;
    if (timestamp != null || level != null) {
      const nextSpace = rest.indexOf(" ");
      if (nextSpace !== -1) {
        const head = rest.slice(0, nextSpace);
        if (CONTAINER_RE.test(head)) {
          container = head;
          rest = rest.slice(nextSpace + 1).trimStart();
        }
      }
    }

    events.push({ timestamp, level, container, message: rest, raw: rawLine, lineNo });
  }
  return events;
}

/* ==========================================================================
   STAGE 2 — normalizer
   ========================================================================== */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const METHOD_RE = new RegExp(`\\b(${METHODS.join("|")})\\b`);
const URL_RE = /(https?:\/\/[^\s"'}]+|\/[A-Za-z0-9._~\-\/]+)/;
const STATUS_RE = /\b(?:status|http_status)\s*[:=]\s*(\d{3})\b|\b(\d{3})\b(?=\s|$)/i;
const KV_RE = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s]+)/g;

interface JsonFields {
  url: string | null;
  method: string | null;
  status: number | null;
  requestId: string | null;
  sender: string | null;
  receiver: string | null;
}

function parseKv(str: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  KV_RE.lastIndex = 0;
  while ((m = KV_RE.exec(str)) !== null) {
    const k = m[1]!;
    let v = m[2]!;
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractFromJson(json: Record<string, unknown> | null): JsonFields {
  if (!json) {
    return { url: null, method: null, status: null, requestId: null, sender: null, receiver: null };
  }
  const req = (json.request ?? {}) as Record<string, unknown>;
  const res = (json.response ?? {}) as Record<string, unknown>;
  return {
    url: pickString(json.url, req.url, res.url),
    method: pickString(json.method, req.method, res.method),
    status: pickNumber(json.status, req.status, res.status),
    requestId: pickString(json.requestId, json.request_id, req.requestId, res.requestId),
    sender: pickString(json.sender, req.sender, res.sender),
    receiver: pickString(json.receiver, req.receiver, res.receiver),
  };
}

let ID = 0;
function nextId(): string {
  ID += 1;
  return `e${ID}`;
}
function resetIds(): void {
  ID = 0;
}

function normalize(events: readonly RawEvent[]): Event[] {
  return events.map((ev) => {
    const json = extractJson(ev.message);
    const kv = parseKv(ev.message);
    const jsonFields = extractFromJson(json);

    const methodMatch = ev.message.match(METHOD_RE);
    const urlMatch = ev.message.match(URL_RE);
    const statusMatch = ev.message.match(STATUS_RE);

    const method = jsonFields.method ?? kv.method ?? methodMatch?.[1] ?? null;
    const url = jsonFields.url ?? kv.url ?? urlMatch?.[1] ?? null;

    const statusRaw =
      jsonFields.status ??
      pickNumber(kv.status, kv.http_status, statusMatch?.[1], statusMatch?.[2]);
    const status = statusRaw != null && statusRaw >= 100 && statusRaw < 600 ? statusRaw : null;

    const sender = jsonFields.sender ?? kv.sender ?? null;
    const receiver = jsonFields.receiver ?? kv.receiver ?? null;
    const requestId = jsonFields.requestId ?? kv.requestId ?? kv.request_id ?? null;

    return {
      id: nextId(),
      timestamp: ev.timestamp,
      service: ev.container ?? sender ?? "",
      container: ev.container,
      type: "UNKNOWN",
      method,
      url,
      status,
      sender,
      receiver,
      requestId,
      resolvedPeer: null,
      isPaired: false,
      message: ev.message,
      raw: ev.raw,
      lineNo: ev.lineNo,
    };
  });
}

/* ==========================================================================
   STAGE 3 — classifier
   ========================================================================== */

const CLASSIFY_RULES: ReadonlyArray<{ type: EventType; re: RegExp }> = [
  { type: "OUT", re: /\b(proxy\s+outgoing|outgoing\s+request|calling\s+|->\s*)/i },
  { type: "IN", re: /\b(incoming\s+request|received\s+request)\b/i },
  {
    type: "RESPONSE",
    re: /\b(proxy\s+incoming\s+response|incoming\s+response|response|http_status|status\s*[:=]\s*\d{3})\b/i,
  },
];

function classify(events: readonly Event[]): Event[] {
  return events.map((ev) => {
    let type: EventType = "UNKNOWN";
    for (const { type: t, re } of CLASSIFY_RULES) {
      if (re.test(ev.message)) {
        type = t;
        break;
      }
    }
    if (type === "UNKNOWN" && ev.status != null) type = "RESPONSE";
    if (type === "UNKNOWN" && ev.sender && ev.receiver && ev.method) type = "OUT";
    return { ...ev, type };
  });
}

/* ==========================================================================
   STAGE 3.5 — correlate (cross-service requestId inference)
   ========================================================================== */

function extractPath(url: string): string {
  const abs = url.match(/^https?:\/\/[^\/]+(\/.*)?$/i);
  if (abs) return (abs[1] ?? "/").split(/[?#]/)[0]!;
  if (url.startsWith("/")) return url.split(/[?#]/)[0]!;
  const slash = url.indexOf("/");
  if (slash !== -1) return url.slice(slash).split(/[?#]/)[0]!;
  return "/";
}

function pathsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = extractPath(a);
  const pb = extractPath(b);
  if (pa === pb) return true;
  if (pa.endsWith(pb) || pb.endsWith(pa)) return true;
  return false;
}

function correlate(events: readonly Event[]): Event[] {
  const byRequestId = new Map<string, Event[]>();
  for (const ev of events) {
    if (!ev.requestId) continue;
    const list = byRequestId.get(ev.requestId) ?? [];
    list.push(ev);
    byRequestId.set(ev.requestId, list);
  }

  const inferredSender = new Map<string, string>();
  const inferredReceiver = new Map<string, string>();
  const paired = new Set<string>();

  for (const group of byRequestId.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const ta = a.timestamp ?? Number.POSITIVE_INFINITY;
      const tb = b.timestamp ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.lineNo - b.lineNo;
    });

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i]!;

      if (ev.type === "IN" && !ev.sender) {
        for (let j = i - 1; j >= 0; j--) {
          const prev = sorted[j]!;
          if (prev.service && prev.service !== ev.service) {
            inferredSender.set(ev.id, prev.service);
            if (prev.type === "OUT") paired.add(ev.id);
            break;
          }
        }
      }

      // Pair only when OUT and candidate IN agree on URL path — avoids
      // binding an external-facing OUT to some unrelated later backend IN
      // that just happens to share the same requestId.
      if (ev.type === "OUT" && !ev.receiver) {
        for (let j = i + 1; j < sorted.length; j++) {
          const next = sorted[j]!;
          if (next.type !== "IN") continue;
          if (!next.service || next.service === ev.service) continue;
          if (pathsMatch(ev.url, next.url)) {
            inferredReceiver.set(ev.id, next.service);
            paired.add(next.id);
          }
          break;
        }
      }
    }
  }

  if (inferredSender.size === 0 && inferredReceiver.size === 0 && paired.size === 0) {
    return events.slice();
  }
  return events.map((ev) => {
    const sUpd = inferredSender.get(ev.id);
    const rUpd = inferredReceiver.get(ev.id);
    const isPaired = paired.has(ev.id);
    if (!sUpd && !rUpd && !isPaired) return ev;
    return {
      ...ev,
      sender: ev.sender ?? sUpd ?? null,
      receiver: ev.receiver ?? rUpd ?? null,
      isPaired: ev.isPaired || isPaired,
    };
  });
}

/* ==========================================================================
   STAGE 4 — virtualize (service / resolvedPeer / url-host resolution)
   ========================================================================== */

const EXTERNAL_PREFIX = "external:";
const VIRTUAL_PREFIX = "virtual:";
const UNKNOWN_PREFIX = "unknown:";

/**
 * Host part of a URL, or null if the URL is a pure path (no host info).
 * Pure paths like "/api/url" describe the route served by the logger
 * itself — not a destination — so we refuse to derive an external node
 * from them.
 */
function urlHost(url: string): string | null {
  const abs = url.match(/^https?:\/\/([^\/\s?#]+)/i);
  if (abs) return abs[1]!;
  if (url.startsWith("/")) return null;
  const slash = url.indexOf("/");
  const beforeSlash = slash === -1 ? url : url.slice(0, slash);
  const host = beforeSlash.split(/[?#]/)[0]!;
  return host.length > 0 ? host : null;
}

function stripPort(host: string): string {
  const i = host.lastIndexOf(":");
  return i > 0 ? host.slice(0, i) : host;
}

function matchKnownContainer(host: string, known: ReadonlySet<string>): string | null {
  const bare = stripPort(host);
  if (known.has(bare)) return bare;
  if (bare.includes(".svc.")) {
    const firstLabel = bare.split(".")[0]!;
    if (known.has(firstLabel)) return firstLabel;
  }
  return null;
}

function targetFromUrl(url: string, known: ReadonlySet<string>): string | null {
  const host = urlHost(url);
  if (!host) return null;
  const matched = matchKnownContainer(host, known);
  return matched ?? `${EXTERNAL_PREFIX}${stripPort(host)}`;
}

function collectKnownContainers(events: readonly Event[]): Set<string> {
  const set = new Set<string>();
  for (const ev of events) {
    if (ev.container) set.add(ev.container);
    if (ev.sender) set.add(ev.sender);
    if (ev.receiver) set.add(ev.receiver);
  }
  return set;
}

function virtualize(events: readonly Event[]): Event[] {
  const known = collectKnownContainers(events);

  return events.map((ev) => {
    let service = ev.service && ev.service.length > 0 ? ev.service : "";
    if (!service) {
      if (ev.sender) service = ev.sender;
      else {
        const fromUrl = ev.url ? targetFromUrl(ev.url, known) : null;
        if (fromUrl) service = fromUrl;
        else if (ev.receiver) service = `${VIRTUAL_PREFIX}${ev.receiver}`;
        else service = `${UNKNOWN_PREFIX}${hash(ev.raw || ev.message || ev.id)}`;
      }
    }

    // Pure paths ("/api/identity/v2/access_token") describe the route
    // served by `service` itself, NOT a destination — targetFromUrl
    // returns null for them, so we don't invent a peer.
    let resolvedPeer: string | null = null;
    if (ev.receiver) resolvedPeer = ev.receiver;
    else if (ev.url) resolvedPeer = targetFromUrl(ev.url, known);
    if (!resolvedPeer && ev.sender && ev.sender !== service) {
      resolvedPeer = ev.sender;
    }

    return { ...ev, service, resolvedPeer };
  });
}

function peerOf(ev: Event): string | null {
  return ev.resolvedPeer;
}

/* ==========================================================================
   MATCHER — score function
   ========================================================================== */

const TIME_WINDOW_MS = 5_000;

function score(request: Event, response: Event): number {
  let s = 0;

  if (request.requestId && response.requestId && request.requestId === response.requestId) {
    s += 0.4;
  }

  if (
    request.sender &&
    request.receiver &&
    response.sender === request.receiver &&
    response.receiver === request.sender
  ) {
    s += 0.2;
  } else if (
    request.service &&
    response.service &&
    (request.service === response.service ||
      (request.receiver != null && response.service === request.receiver) ||
      (response.sender != null && response.sender === request.receiver))
  ) {
    s += 0.1;
  }

  if (request.url && response.url) {
    if (request.url === response.url) s += 0.2;
    else if (sharePath(request.url, response.url)) s += 0.1;
  }

  if (request.method && response.method && request.method === response.method) {
    s += 0.1;
  }

  if (request.timestamp != null && response.timestamp != null) {
    const dt = response.timestamp - request.timestamp;
    if (dt >= 0) {
      if (dt <= TIME_WINDOW_MS) s += 0.1;
      else if (dt <= 2 * TIME_WINDOW_MS) {
        s += 0.1 * (1 - (dt - TIME_WINDOW_MS) / TIME_WINDOW_MS);
      }
    }
  }

  return Math.min(1, Math.max(0, s));
}

function sharePath(a: string, b: string): boolean {
  const ap = a.replace(/^https?:\/\/[^\/]+/, "");
  const bp = b.replace(/^https?:\/\/[^\/]+/, "");
  return ap.length > 0 && ap === bp;
}

interface MatchResult {
  match: Event | null;
  score: number;
}

function bestMatch(
  response: Event,
  candidates: readonly Event[],
  opts: { min?: number } = {},
): MatchResult {
  const min = opts.min ?? 0.2;
  let best: Event | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = score(c, response);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (bestScore < min) return { match: null, score: bestScore };
  return { match: best, score: bestScore };
}

/* ==========================================================================
   STACK — core algorithm with backtracking + fan-out
   ========================================================================== */

const CLIENT = "client";

interface BuildResult {
  edges: Edge[];
  unresolved: StackFrame[];
}
interface BuildOptions {
  includeClient?: boolean;
}

function roundN(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeEdge(args: {
  from: string;
  to: string;
  type: EdgeType;
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
    confidence: roundN(args.confidence),
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

function buildEdges(events: readonly Event[], opts: BuildOptions = {}): BuildResult {
  const includeClient = opts.includeClient ?? false;
  const edges: Edge[] = [];
  const stack: StackFrame[] = [];

  for (const ev of events) {
    if (ev.type === "IN" || ev.type === "OUT") {
      const edge = handleRequest(ev, edges, includeClient);
      stack.push({ ev, edge });
    } else if (ev.type === "RESPONSE") {
      handleResponse(ev, stack, edges, includeClient);
    }
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
  if (from == null) return null;
  const edge = makeEdge({
    from,
    to,
    type: "REQUEST",
    ev,
    confidence: baseConfidence(ev),
    evidence: [ev.id],
  });
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
    const responder = ev.service;
    const caller = ev.receiver ?? ev.sender ?? peerOf(ev) ?? (includeClient ? CLIENT : null);
    if (caller == null) return;
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
  }

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

/* ==========================================================================
   GRAPH — final Trace + dedup + service classification
   ========================================================================== */

let REQUEST_ID = 0;
function nextRequestId(): string {
  REQUEST_ID += 1;
  return `r${REQUEST_ID}`;
}

interface BuildGraphInput {
  edges: Edge[];
  unresolved: StackFrame[];
  events: readonly Event[];
  includeClient?: boolean;
}

function buildGraph({
  edges,
  unresolved,
  events,
  includeClient = false,
}: BuildGraphInput): Trace {
  const closedEdges = edges.slice();
  for (const frame of unresolved) {
    if (!frame.edge) continue;
    if (frame.ev.isPaired) continue;
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
    confidence: roundN(confidence),
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

/* ==========================================================================
   PIPELINE — run()
   ========================================================================== */

export type PipelineInput = string | readonly string[] | readonly RawEvent[];

function isRawEventArray(x: PipelineInput): x is readonly RawEvent[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    typeof x[0] === "object" &&
    x[0] !== null &&
    "message" in (x[0] as object) &&
    "lineNo" in (x[0] as object)
  );
}

export function run(input: PipelineInput): Trace;
export function run(input: PipelineInput, opts: PipelineOptions & { debug: true }): DebugTrace;
export function run(
  input: PipelineInput,
  opts: Omit<PipelineOptions, "debug"> & { debug?: false | undefined },
): Trace;
export function run(input: PipelineInput, opts: PipelineOptions): Trace | DebugTrace;
export function run(input: PipelineInput, opts: PipelineOptions = {}): Trace | DebugTrace {
  resetIds();

  let parsed: RawEvent[];
  if (typeof input === "string") {
    parsed = parseLines(input.split(/\r?\n/));
  } else if (isRawEventArray(input)) {
    parsed = input.slice();
  } else {
    parsed = parseLines(input as readonly string[]);
  }

  const normalized = normalize(parsed);
  const classified = classify(normalized);
  const correlated = correlate(classified);
  const virtualized = virtualize(correlated);

  const ordered: Event[] = virtualized
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const ta = a.ev.timestamp;
      const tb = b.ev.timestamp;
      if (ta == null && tb == null) return a.i - b.i;
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.ev);

  const { edges, unresolved } = buildEdges(ordered, { includeClient: opts.includeClient });
  const graph = buildGraph({
    edges,
    unresolved,
    events: ordered,
    includeClient: opts.includeClient,
  });

  return opts.debug ? { graph, events: ordered } : graph;
}

/* ==========================================================================
   ADAPTER — Graylog MessageContent[] → RawEvent[]
   ========================================================================== */

const LEVEL_NAMES: Record<number, string> = {
  0: "FATAL",
  1: "ALERT",
  2: "CRITICAL",
  3: "ERROR",
  4: "WARN",
  5: "NOTICE",
  6: "INFO",
  7: "DEBUG",
};

function parseIsoTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const POD_SUFFIX_RE = /-[a-z0-9]{5,10}-[a-z0-9]{5}$/;
function stripPodSuffix(pod: string): string {
  return pod.replace(POD_SUFFIX_RE, "");
}

function deriveContainer(m: MessageContent): string | null {
  if (m.container) return m.container;
  if (m.component) return m.component;
  if (m.service) return m.service;
  if (m.pod) return stripPodSuffix(m.pod);
  if (m.source) return m.source;
  if (m.hostname) return m.hostname;
  return null;
}

function pickRequestId(m: MessageContent): string | undefined {
  return m.requestId ?? m.request_id;
}

export function fromMessageContent(messages: readonly MessageContent[]): RawEvent[] {
  const out: RawEvent[] = [];
  let lineNo = 0;
  for (const m of messages) {
    lineNo += 1;
    const rawMessage = typeof m.message === "string" ? m.message : String(m.message);
    const ts =
      parseInlineIsoTimestamp(rawMessage) ??
      parseIsoTimestamp(m.timestamp) ??
      parseIsoTimestamp(m.time);
    const rid = pickRequestId(m);
    const enrichedMessage = rid ? `${rawMessage} requestId=${rid}` : rawMessage;
    const level = typeof m.level === "number" ? LEVEL_NAMES[m.level] ?? null : null;

    out.push({
      timestamp: ts,
      level,
      container: deriveContainer(m),
      message: enrichedMessage,
      raw: rawMessage,
      lineNo,
    });
  }
  return out;
}
