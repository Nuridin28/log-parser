// Adapter: Graylog / GELF MessageContent → pipeline RawEvent.
//
// Fields that already come structured (container, timestamp, requestId)
// are lifted directly — we skip Stage 1 parsing for them. The inner
// `message` text is still passed through the normalizer so URL / method /
// status / sender / receiver get extracted as before.
//
// Usage:
//   import { fromMessageContent } from "./adapters/graylog.ts";
//   const trace = run(fromMessageContent(messages));

import type { MessageContent, RawEvent } from "../types.ts";
import { parseInlineIsoTimestamp } from "../utils/time.ts";

// Graylog numeric level → syslog-style name.
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

/**
 * Pick the most specific identifier of the source service. Some log
 * pipelines leave `container` empty but carry enough hints elsewhere.
 *
 * Order of preference:
 *   container  — directly the container/app name (best)
 *   component  — a logical component identifier
 *   service    — what the running code calls itself (real logs often have this)
 *   pod        — k8s pod name (strip Deployment hash suffix)
 *   source     — fluentd / syslog source
 *   hostname   — last resort
 */
function deriveContainer(m: MessageContent): string | null {
  if (m.container) return m.container;
  if (m.component) return m.component;
  if (m.service) return m.service;
  if (m.pod) return stripPodSuffix(m.pod);
  if (m.source) return m.source;
  if (m.hostname) return m.hostname;
  return null;
}

const POD_SUFFIX_RE = /-[a-z0-9]{5,10}-[a-z0-9]{5}$/;
function stripPodSuffix(pod: string): string {
  return pod.replace(POD_SUFFIX_RE, "");
}

/** Accept either snake_case `request_id` or camelCase `requestId`. */
function pickRequestId(m: MessageContent): string | undefined {
  return m.requestId ?? m.request_id;
}

/**
 * Convert a MessageContent[] into RawEvent[].
 *
 * We append `requestId=<id>` to the message so the existing key=value
 * extractor in normalizer.ts lifts it into `Event.requestId` without
 * changes to the pipeline. (Many messages already contain `[requestId=...]`
 * inline — duplicates are harmless.)
 */
export function fromMessageContent(messages: readonly MessageContent[]): RawEvent[] {
  const out: RawEvent[] = [];
  let lineNo = 0;
  for (const m of messages) {
    lineNo += 1;
    const rawMessage = typeof m.message === "string" ? m.message : String(m.message);
    // Prefer the inline `[ISO]` timestamp from the message body — it reflects
    // the moment the log line was written. Graylog's `timestamp` / `time`
    // fields can be ingestion time, which is shifted (seen ~0.6s drift in
    // real logs) and breaks causal ordering across services.
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
