import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Trace } from "../src/types.ts";
import { run } from "../src/pipeline.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, "..", "examples");

function load(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function types(graph: Trace): string[] {
  return graph.edges.map((e) => e.type);
}

test("case1 — normal flow produces matched REQUEST/RESPONSE edges", () => {
  const graph = run(load("case1-normal.log"));
  assert.ok(graph.edges.length >= 4);
  assert.ok(graph.edges.some((e) => e.type === "REQUEST"));
  assert.ok(graph.edges.some((e) => e.type === "RESPONSE"));
  assert.ok(graph.confidence > 0);
});

test("case2 — response-only synthesizes INFERRED_REQUEST", () => {
  const graph = run(load("case2-no-request.log"));
  const ts = types(graph);
  assert.ok(ts.includes("INFERRED_REQUEST"), `got: ${ts.join(",")}`);
  assert.ok(ts.includes("RESPONSE"));
});

test("case3 — backtracking emits INFERRED_RESPONSE for skipped frames", () => {
  const graph = run(load("case3-backtrack.log"));
  const inferred = graph.edges.filter((e) => e.type === "INFERRED_RESPONSE");
  assert.ok(inferred.length >= 1, "expected at least one inferred response");
});

test("case4 — sender/receiver drives edge direction", () => {
  const graph = run(load("case4-sender-receiver.log"));
  const req = graph.edges.find((e) => e.type === "REQUEST");
  const res = graph.edges.find((e) => e.type === "RESPONSE");
  assert.ok(req && res);
  assert.equal(req.from, "api");
  assert.equal(req.to, "payment");
  assert.equal(res.from, "payment");
  assert.equal(res.to, "api");
});

test("case5 — async fan-out sets parallel flag", () => {
  const graph = run(load("case5-async.log"));
  assert.equal(graph.parallel, true);
  assert.equal(graph.edges.filter((e) => e.type === "REQUEST").length, 2);
  assert.equal(graph.edges.filter((e) => e.type === "RESPONSE").length, 2);
});

test("output shape — { requestId, edges:{from,to,message,type}, services }", () => {
  const graph = run(load("case1-normal.log"));
  assert.ok(typeof graph.requestId === "string");
  assert.ok(Array.isArray(graph.edges));
  assert.ok(Array.isArray(graph.services));
  assert.ok(typeof graph.confidence === "number");
  for (const e of graph.edges) {
    assert.ok(typeof e.from === "string");
    assert.ok(typeof e.to === "string");
    assert.ok("message" in e);
  }
  const referenced = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  for (const node of referenced) assert.ok(graph.services.includes(node));
});
