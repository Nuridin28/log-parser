// Virtualization — every event must have a *service* identifier so the
// causal graph is never disconnected (spec §6).
//
// Priority:
//   1. explicit container/sender (set by normalizer)
//   2. external:<url>            — URL is present
//   3. virtual:<receiver>        — only a peer name
//   4. unknown:<hash of raw>     — last resort, deterministic

import type { Event } from "./types.ts";
import { hash } from "./utils/hash.ts";

function urlHost(url: string): string {
  const m = url.match(/^https?:\/\/([^\/\s]+)(\/.*)?$/i);
  if (m) return m[1]! + (m[2] ?? "");
  return url;
}

export function virtualize(events: readonly Event[]): Event[] {
  return events.map((ev) => {
    if (ev.service && ev.service.length > 0) return ev;
    let service: string;
    if (ev.url) service = `external:${urlHost(ev.url)}`;
    else if (ev.receiver) service = `virtual:${ev.receiver}`;
    else if (ev.sender) service = `virtual:${ev.sender}`;
    else service = `unknown:${hash(ev.raw || ev.message || ev.id)}`;
    return { ...ev, service };
  });
}

/** The "other side" of the conversation, used when ev has no explicit peer. */
export function peerOf(ev: Event): string | null {
  if (ev.receiver) return ev.receiver;
  if (ev.url) return `external:${urlHost(ev.url)}`;
  if (ev.sender) return ev.sender;
  return null;
}
