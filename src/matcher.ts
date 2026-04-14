// Matching engine (spec §7).
//   score(A, B) =
//     + 0.4  requestId match
//     + 0.2  sender/receiver pairing
//     + 0.2  url match
//     + 0.1  method match
//     + 0.1  temporal proximity
// Timestamps contribute only 10% — async + network delay make them
// unreliable as a primary causal signal (spec §7.2).

import type { Event } from "./types.ts";

const TIME_WINDOW_MS = 5_000;

export function score(request: Event, response: Event): number {
  let s = 0;

  if (request.requestId && response.requestId && request.requestId === response.requestId) {
    s += 0.4;
  }

  if (
    request.sender &&
    request.receiver &&
    response.sender === request.receiver &&
    response.receiver === request.sender
  ) {
    s += 0.2;
  } else if (
    request.service &&
    response.service &&
    (request.service === response.service ||
      (request.receiver != null && response.service === request.receiver) ||
      (response.sender != null && response.sender === request.receiver))
  ) {
    s += 0.1;
  }

  if (request.url && response.url) {
    if (request.url === response.url) s += 0.2;
    else if (sharePath(request.url, response.url)) s += 0.1;
  }

  if (request.method && response.method && request.method === response.method) {
    s += 0.1;
  }

  if (request.timestamp != null && response.timestamp != null) {
    const dt = response.timestamp - request.timestamp;
    if (dt >= 0) {
      if (dt <= TIME_WINDOW_MS) s += 0.1;
      else if (dt <= 2 * TIME_WINDOW_MS) {
        s += 0.1 * (1 - (dt - TIME_WINDOW_MS) / TIME_WINDOW_MS);
      }
    }
  }

  return Math.min(1, Math.max(0, s));
}

function sharePath(a: string, b: string): boolean {
  const ap = a.replace(/^https?:\/\/[^\/]+/, "");
  const bp = b.replace(/^https?:\/\/[^\/]+/, "");
  return ap.length > 0 && ap === bp;
}

export interface MatchResult {
  match: Event | null;
  score: number;
}

export function bestMatch(
  response: Event,
  candidates: readonly Event[],
  opts: { min?: number } = {},
): MatchResult {
  const min = opts.min ?? 0.2;
  let best: Event | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = score(c, response);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (bestScore < min) return { match: null, score: bestScore };
  return { match: best, score: bestScore };
}
