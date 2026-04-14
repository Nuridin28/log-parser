// Virtualization — every event must have a *service* identifier so the
// causal graph is never disconnected (spec §6).
//
// Priority:
//   1. explicit container (already set by normalizer)                 → "api"
//   2. external:<url host>   — OUT/RESPONSE pointing at a URL          → "external:stripe.com"
//   3. virtual:<receiver>    — known peer name, no logs from it        → "virtual:payment"
//   4. unknown:<hash>        — last resort, deterministic               → "unknown:3f9a…"
//
// Names are used **verbatim** as edge.from/to. The `external:`, `virtual:`,
// `unknown:` prefixes are load-bearing — graph.ts uses them to classify
// ServiceNode.kind for the public output.

import type { Event } from "./types.ts";
import { hash } from "./utils/hash.ts";

export const EXTERNAL_PREFIX = "external:";
export const VIRTUAL_PREFIX = "virtual:";
export const UNKNOWN_PREFIX = "unknown:";

/**
 * Extract the host from a URL. We intentionally drop the path so
 * "https://stripe.com/charges" and "https://stripe.com/customers" collapse
 * into the same third-party node. The path stays in the edge's message.
 */
export function urlHost(url: string): string {
  const m = url.match(/^https?:\/\/([^\/\s?#]+)/i);
  if (m) return m[1]!;
  // Relative URL — no host to key on. Fall back to the path itself.
  return url.split(/[?#]/)[0]!;
}

export function virtualize(events: readonly Event[]): Event[] {
  return events.map((ev) => {
    if (ev.service && ev.service.length > 0) return ev;
    let service: string;
    if (ev.url) service = `${EXTERNAL_PREFIX}${urlHost(ev.url)}`;
    else if (ev.receiver) service = `${VIRTUAL_PREFIX}${ev.receiver}`;
    else if (ev.sender) service = `${VIRTUAL_PREFIX}${ev.sender}`;
    else service = `${UNKNOWN_PREFIX}${hash(ev.raw || ev.message || ev.id)}`;
    return { ...ev, service };
  });
}

/**
 * The "other side" of the conversation, for events whose peer isn't named
 * explicitly. This is what answers questions like "api is making an outgoing
 * call — who to?" when the receiver isn't in the log.
 *
 * Order:
 *   1. explicit receiver         → internal service
 *   2. URL                       → external:<host>  (third-party)
 *   3. sender                    → fallback for RESPONSE events
 */
export function peerOf(ev: Event): string | null {
  if (ev.receiver) return ev.receiver;
  if (ev.url) return `${EXTERNAL_PREFIX}${urlHost(ev.url)}`;
  if (ev.sender) return ev.sender;
  return null;
}
