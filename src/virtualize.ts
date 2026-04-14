// Virtualization — every event must have a *service* identifier so the
// causal graph is never disconnected (spec §6). Runs in two passes:
//
//   Pass 1: collect the set of container names we have direct evidence for
//           (anything that appears as `ev.container` in the batch).
//   Pass 2: for each event, fill in service + resolvedPeer. When we would
//           otherwise create `external:<host>`, first check if <host>
//           (stripped of port, optionally first DNS label) matches a known
//           container — if it does, use that container instead.
//
// This fixes the common case: a container `api` logging an outgoing call
// to `http://payment:8080/charge` should resolve the target to the already-
// known container `payment`, not to a new `external:payment:8080` node.

import type { Event } from "./types.ts";
import { hash } from "./utils/hash.ts";

export const EXTERNAL_PREFIX = "external:";
export const VIRTUAL_PREFIX = "virtual:";
export const UNKNOWN_PREFIX = "unknown:";

/**
 * Extract the host from a URL.
 *
 *   https://api.stripe.com/charges        → "api.stripe.com"
 *   http://payment:8080/api               → "payment:8080"
 *   ipOfServiceOutg/auth/realms/token     → "ipOfServiceOutg"   (no protocol)
 *   /api/url                              → "/api/url"          (pure path)
 *
 * When the input has no protocol and no leading slash, we treat everything
 * before the first "/" as the host — real logs often omit the scheme but
 * still put host-like tokens up front.
 */
export function urlHost(url: string): string {
  const abs = url.match(/^https?:\/\/([^\/\s?#]+)/i);
  if (abs) return abs[1]!;
  if (url.startsWith("/")) return url.split(/[?#]/)[0]!;
  const slash = url.indexOf("/");
  const beforeSlash = slash === -1 ? url : url.slice(0, slash);
  return beforeSlash.split(/[?#]/)[0]!;
}

/** Strip ":port" suffix from a host. "payment:8080" → "payment". */
function stripPort(host: string): string {
  const i = host.lastIndexOf(":");
  return i > 0 ? host.slice(0, i) : host;
}

/**
 * Try to resolve a URL host to a known internal container name.
 *
 * A host with dots is external by default (`api.stripe.com`, `example.org`).
 * It must NOT collapse to a container just because its first label happens
 * to coincide with one. The only exceptions:
 *
 *   1. Full host (minus port) exactly matches a known container.
 *      Covers k8s short names: `http://payment:8080` → `payment`.
 *
 *   2. Host is explicit k8s DNS (contains `.svc.`), in which case the
 *      first label is the service name by convention:
 *      `payment.default.svc.cluster.local` → `payment`.
 */
function matchKnownContainer(host: string, known: ReadonlySet<string>): string | null {
  const bare = stripPort(host);
  if (known.has(bare)) return bare;
  if (bare.includes(".svc.")) {
    const firstLabel = bare.split(".")[0]!;
    if (known.has(firstLabel)) return firstLabel;
  }
  return null;
}

/**
 * Derive a target identifier from a URL:
 *   - matches a known container → plain container name (kind=container)
 *   - otherwise                 → external:<host>  (kind=external)
 */
function targetFromUrl(url: string, known: ReadonlySet<string>): string {
  const host = urlHost(url);
  const matched = matchKnownContainer(host, known);
  return matched ?? `${EXTERNAL_PREFIX}${stripPort(host)}`;
}

function collectKnownContainers(events: readonly Event[]): Set<string> {
  const set = new Set<string>();
  for (const ev of events) {
    if (ev.container) set.add(ev.container);
    // `sender` / `receiver` in explicit key=value logs are also trustworthy
    // signals of service names that exist in the system.
    if (ev.sender) set.add(ev.sender);
    if (ev.receiver) set.add(ev.receiver);
  }
  return set;
}

export function virtualize(events: readonly Event[]): Event[] {
  const known = collectKnownContainers(events);

  return events.map((ev) => {
    // --- service (who wrote this log) --------------------------------
    let service = ev.service && ev.service.length > 0 ? ev.service : "";
    if (!service) {
      // No container — try sender (explicit), then URL-host match.
      if (ev.sender) service = ev.sender;
      else if (ev.url) service = targetFromUrl(ev.url, known);
      else if (ev.receiver) service = `${VIRTUAL_PREFIX}${ev.receiver}`;
      else service = `${UNKNOWN_PREFIX}${hash(ev.raw || ev.message || ev.id)}`;
    }

    // --- resolvedPeer (the other side) -------------------------------
    let resolvedPeer: string | null = null;
    if (ev.receiver) {
      // Receiver is explicit — trust it, but still check if it's a known
      // container (it usually will be, because collectKnownContainers adds it).
      resolvedPeer = ev.receiver;
    } else if (ev.url) {
      resolvedPeer = targetFromUrl(ev.url, known);
    } else if (ev.sender && ev.sender !== service) {
      resolvedPeer = ev.sender;
    }

    return { ...ev, service, resolvedPeer };
  });
}

/**
 * The "other side" of the conversation for an event — what we push into
 * edge.to for an OUT, or edge.from for a RESPONSE that came out of nowhere.
 */
export function peerOf(ev: Event): string | null {
  return ev.resolvedPeer;
}
