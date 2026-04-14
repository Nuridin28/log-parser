// Stage 1 — Parsing.
// Grammar (lenient): [HH:MM:SS.mmm] LEVEL [container] message...
// We bias toward producing *something* for every line — the system must
// be "total" per spec §12 (never drop input).

import type { RawEvent } from "./types.ts";
import { parseTimestamp, stripTimestamp } from "./utils/time.ts";

const LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"]);
const CONTAINER_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function parseLines(rawLines: readonly string[]): RawEvent[] {
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

    // Only attempt container extraction if we anchored on timestamp or level —
    // otherwise we'd be guessing on totally unstructured lines.
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
