// Pipeline — orchestrates the six stages end to end.
//
//   raw lines
//     → parser      (Stage 1)
//     → normalizer  (Stage 2)
//     → classifier  (Stage 3)
//     → virtualize  (virtual nodes)
//     → stack       (core algorithm + backtracking)
//     → graph       (final public Trace)

import type { DebugTrace, Event, PipelineOptions, Trace } from "./types.ts";
import { parseLines } from "./parser.ts";
import { normalize, resetIds } from "./normalizer.ts";
import { classify } from "./classifier.ts";
import { virtualize } from "./virtualize.ts";
import { buildEdges } from "./stack.ts";
import { buildGraph } from "./graph.ts";

export function run(rawInput: string | readonly string[]): Trace;
export function run(rawInput: string | readonly string[], opts: { debug: true }): DebugTrace;
export function run(
  rawInput: string | readonly string[],
  opts?: PipelineOptions,
): Trace | DebugTrace;
export function run(
  rawInput: string | readonly string[],
  opts: PipelineOptions = {},
): Trace | DebugTrace {
  resetIds();
  const lines = Array.isArray(rawInput) ? rawInput : (rawInput as string).split(/\r?\n/);
  const parsed = parseLines(lines);
  const normalized = normalize(parsed);
  const classified = classify(normalized);
  const virtualized = virtualize(classified);

  // Stable sort by timestamp — events without a timestamp keep their
  // original position among themselves.
  const ordered: Event[] = virtualized
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const ta = a.ev.timestamp;
      const tb = b.ev.timestamp;
      if (ta == null && tb == null) return a.i - b.i;
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.ev);

  const { edges, unresolved } = buildEdges(ordered);
  const graph = buildGraph({ edges, unresolved, events: ordered });

  return opts.debug ? { graph, events: ordered } : graph;
}
