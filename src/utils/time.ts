// Parse a bracketed timestamp into a stable numeric value.
//
// Two shapes are supported:
//   [HH:MM:SS.mmm]                        → ms since start of day
//   [YYYY-MM-DDTHH:MM:SS(.fff)(Z|±HH:MM)] → ms since epoch (ISO 8601)
//
// Real-world logs routinely embed the event time at the start of the
// message body itself (e.g. Graylog wraps logs where the ingestion time
// differs from the actual event time). Reading the inline timestamp is
// the only way to get correct causal ordering across services.

const SHORT_TS_RE = /^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;
const ISO_TS_RE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\]/;

export function parseTimestamp(line: string): number | null {
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

/**
 * Extract an inline ISO timestamp from the start of a message body.
 * Returns ms since epoch, or null if the message doesn't begin with an
 * ISO-shaped `[...]` prefix.
 */
export function parseInlineIsoTimestamp(message: string): number | null {
  const m = message.match(ISO_TS_RE);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : null;
}

export function stripTimestamp(line: string): string {
  return line.replace(ISO_TS_RE, "").replace(SHORT_TS_RE, "").trimStart();
}
