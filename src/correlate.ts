// Correlation stage — wires up sender/receiver for events that share
// a `requestId` but didn't have explicit sender/receiver fields.
//
// In real distributed traces the story looks like:
//
//   service   [IN]  POST /api/url         requestId=X        ← entry point
//   service   ...internal processing...   requestId=X
//   service2  [IN]  HTTP Incoming         requestId=X        ← was called by service
//   service2  [OUT] Proxy Outgoing        requestId=X        ← calls third party
//   service2  [RES] Proxy Incoming        requestId=X        ← third party replied
//   service2  [RES] HTTP Outgoing         requestId=X        ← replies to service
//
// Every event carries the same `requestId`, but `service` never logs an
// explicit "I'm calling service2" line — yet we want the graph to show
// `service → service2`. Without this stage `service2`'s IN would look
// like it came from the synthetic `client`.
//
// Algorithm:
//   For each requestId group, sort by timestamp. For every IN event
//   without an explicit sender, set sender = the service of the most
//   recent earlier event from a *different* service.
//
// The stack/matcher then does the right thing automatically — when the
// corresponding RESPONSE fires, it reverses the inferred (sender→receiver)
// edge and produces `service2 → service`.

import type { Event } from "./types.ts";

export function correlate(events: readonly Event[]): Event[] {
  const byRequestId = new Map<string, Event[]>();
  for (const ev of events) {
    if (!ev.requestId) continue;
    const list = byRequestId.get(ev.requestId) ?? [];
    list.push(ev);
    byRequestId.set(ev.requestId, list);
  }

  // eventId → inferred sender
  const inferred = new Map<string, string>();

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
      if (ev.type !== "IN") continue;
      if (ev.sender) continue;

      // Most recent earlier event from a *different* service.
      for (let j = i - 1; j >= 0; j--) {
        const prev = sorted[j]!;
        if (prev.service && prev.service !== ev.service) {
          inferred.set(ev.id, prev.service);
          break;
        }
      }
    }
  }

  if (inferred.size === 0) return events.slice();
  return events.map((ev) => {
    const s = inferred.get(ev.id);
    return s && !ev.sender ? { ...ev, sender: s } : ev;
  });
}
