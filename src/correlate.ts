// Correlation stage — wires up sender / receiver for events that share
// a `requestId` but didn't have explicit sender/receiver fields.
//
// This is what lets us say "service1 called service2" even when service1
// doesn't log an explicit outgoing line — we see service2's IN event and,
// because they share a requestId, we know who called.
//
// It is also what prevents creation of bogus `external:<host>` nodes
// when service1 logs an Outgoing Request to a URL whose host doesn't
// look like any known container, but the actual callee (service2) does
// have correlated IN logs in the batch. Without this, we'd emit BOTH
// `service1 → external:<host>` AND `service1 → service2`.
//
// Two inferences per requestId group (groups sorted by timestamp):
//
//   A) IN without sender
//      → find the most recent earlier event from a DIFFERENT service.
//         That service is the caller. Set sender = that.service.
//
//   B) OUT without receiver
//      → find the nearest later IN from a DIFFERENT service.
//         That service is the callee. Set receiver = that.service.
//
// After correlate, virtualize uses receiver/sender before falling back
// to URL-based naming, so an OUT with an inferred receiver goes to
// the known container rather than an external: node.

import type { Event } from "./types.ts";

export function correlate(events: readonly Event[]): Event[] {
  const byRequestId = new Map<string, Event[]>();
  for (const ev of events) {
    if (!ev.requestId) continue;
    const list = byRequestId.get(ev.requestId) ?? [];
    list.push(ev);
    byRequestId.set(ev.requestId, list);
  }

  const inferredSender = new Map<string, string>();
  const inferredReceiver = new Map<string, string>();
  const paired = new Set<string>(); // eventIds of INs paired with an OUT

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

      // (A) Infer sender for IN events. If the inference points to an
      // earlier OUT from another service, mark this IN as paired — we
      // are going to fold both sides into one edge, so the IN's own
      // REQUEST emission should be suppressed.
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

      // (B) Infer receiver for OUT events.
      if (ev.type === "OUT" && !ev.receiver) {
        for (let j = i + 1; j < sorted.length; j++) {
          const next = sorted[j]!;
          if (next.type !== "IN") continue;
          if (next.service && next.service !== ev.service) {
            inferredReceiver.set(ev.id, next.service);
            paired.add(next.id);
            break;
          }
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
