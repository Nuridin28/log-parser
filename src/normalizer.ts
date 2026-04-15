// Stage 2 — Normalization.
// Merges signal from three possible message shapes (JSON / key=value / plain)
// into one canonical Event. Whichever shape carries a slot wins.

import type { RawEvent, Event } from "./types.ts";
import { extractJson } from "./utils/json.ts";

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

export function resetIds(): void {
  ID = 0;
}

export function normalize(events: readonly RawEvent[]): Event[] {
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
    const requestId =
      jsonFields.requestId ?? kv.requestId ?? kv.request_id ?? null;

    return {
      id: nextId(),
      timestamp: ev.timestamp,
      // `service` will be backfilled by virtualize.ts if still null.
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
