// Stage 3 — Classification.
// Assigns IN | OUT | RESPONSE | UNKNOWN based on text signals + extracted fields.

import type { Event, EventType } from "./types.ts";

const RULES: ReadonlyArray<{ type: EventType; re: RegExp }> = [
  { type: "OUT", re: /\b(proxy\s+outgoing|outgoing\s+request|calling\s+|->\s*)/i },
  { type: "IN", re: /\b(incoming\s+request|received\s+request)\b/i },
  {
    type: "RESPONSE",
    re: /\b(proxy\s+incoming\s+response|incoming\s+response|response|http_status|status\s*[:=]\s*\d{3})\b/i,
  },
];

export function classify(events: readonly Event[]): Event[] {
  return events.map((ev) => {
    let type: EventType = "UNKNOWN";
    for (const { type: t, re } of RULES) {
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
