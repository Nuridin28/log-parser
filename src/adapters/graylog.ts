// Adapter: Graylog / GELF MessageContent → pipeline RawEvent.
//
// Fields that already come structured (container, timestamp, request_id)
// are lifted directly — we skip Stage 1 parsing for them. The inner
// `message` text is still passed through the normalizer so URL / method /
// status / sender / receiver get extracted as before.
//
// Usage:
//   import { fromMessageContent } from "./adapters/graylog.ts";
//   const trace = run(fromMessageContent(messages), { preParsed: true });

import type { MessageContent, RawEvent } from "../types.ts";

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

function parseIsoTimestamp(iso: string): number | null {
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
 *   source     — syslog source (often the hostname or app name)
 *   pod        — k8s pod name (e.g. "payment-7d9c8f4b6-xy2z3" — strip the
 *                ReplicaSet hash to get "payment")
 *   hostname   — last resort
 *
 * For `pod`, we strip the trailing `-<rshash>-<podhash>` pattern so that
 * all pods of one Deployment collapse to a single service node.
 */
function deriveContainer(m: MessageContent): string | null {
  if (m.container) return m.container;
  if (m.component) return m.component;
  if (m.source) return m.source;
  if (m.pod) return stripPodSuffix(m.pod);
  if (m.hostname) return m.hostname;
  return null;
}

const POD_SUFFIX_RE = /-[a-z0-9]{5,10}-[a-z0-9]{5}$/;
function stripPodSuffix(pod: string): string {
  return pod.replace(POD_SUFFIX_RE, "");
}

/**
 * Convert a MessageContent[] into RawEvent[], preserving the `request_id`
 * correlation ID in a side-channel that the normalizer picks up.
 *
 * We encode `request_id` into the `message` as `requestId=<id>` so the
 * existing key=value extractor in normalizer.ts lifts it into
 * `Event.requestId` without any changes to the pipeline.
 */
export function fromMessageContent(messages: readonly MessageContent[]): RawEvent[] {
  const out: RawEvent[] = [];
  let lineNo = 0;
  for (const m of messages) {
    lineNo += 1;
    const ts = parseIsoTimestamp(m.timestamp) ?? parseIsoTimestamp(m.time);
    const rid = m.request_id ? ` requestId=${m.request_id}` : "";
    out.push({
      timestamp: ts,
      level: LEVEL_NAMES[m.level] ?? null,
      container: deriveContainer(m),
      message: `${m.message}${rid}`,
      raw: m.message,
      lineNo,
    });
  }
  return out;
}
