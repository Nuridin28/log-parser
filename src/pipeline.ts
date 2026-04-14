// Pipeline — orchestrates the stages end to end.
//
//   raw lines / RawEvent[]
//     → parser      (Stage 1 — skipped if input is already RawEvent[])
//     → normalizer  (Stage 2)
//     → classifier  (Stage 3)
//     → virtualize  (virtual nodes)
//     → stack       (core algorithm + backtracking)
//     → graph       (final public Trace)

import type { DebugTrace, Event, PipelineOptions, RawEvent, Trace } from "./types.ts";
import { parseLines } from "./parser.ts";
import { normalize, resetIds } from "./normalizer.ts";
import { classify } from "./classifier.ts";
import { virtualize } from "./virtualize.ts";
import { buildEdges } from "./stack.ts";
import { buildGraph } from "./graph.ts";

export type PipelineInput = string | readonly string[] | readonly RawEvent[];

function isRawEventArray(x: PipelineInput): x is readonly RawEvent[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    typeof x[0] === "object" &&
    x[0] !== null &&
    "message" in (x[0] as object) &&
    "lineNo" in (x[0] as object)
  );
}

export function run(input: PipelineInput): Trace;
export function run(input: PipelineInput, opts: { debug: true }): DebugTrace;
export function run(input: PipelineInput, opts?: PipelineOptions): Trace | DebugTrace;
export function run(input: PipelineInput, opts: PipelineOptions = {}): Trace | DebugTrace {
  resetIds();

  let parsed: RawEvent[];
  if (typeof input === "string") {
    parsed = parseLines(input.split(/\r?\n/));
  } else if (isRawEventArray(input)) {
    parsed = input.slice();
  } else {
    parsed = parseLines(input as readonly string[]);
  }

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
