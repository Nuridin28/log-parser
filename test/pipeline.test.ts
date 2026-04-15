import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Trace } from "../src/types.ts";
import { run } from "../src/pipeline.ts";
import { fromMessageContent } from "../src/adapters/graylog.ts";
import type { MessageContent } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, "..", "examples");

function load(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function types(graph: Trace): string[] {
  return graph.edges.map((e) => e.type);
}

test("case1 — normal flow produces matched REQUEST/RESPONSE edges (spec-mode)", () => {
  // Spec §10 case 1 uses the synthetic `client` lifeline — explicitly opt in.
  const graph = run(load("case1-normal.log"), { includeClient: true });
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
  const serviceNames = new Set(graph.services.map((s) => s.name));
  for (const node of referenced) assert.ok(serviceNames.has(node), `missing service: ${node}`);
});

test("case6 — multiple calls to same third-party collapse to one external node", () => {
  const graph = run(load("case6-third-party.log"));
  const stripeNodes = graph.services.filter(
    (s) => s.kind === "external" && s.host === "api.stripe.com",
  );
  assert.equal(stripeNodes.length, 1, "expected exactly one external:api.stripe.com node");
  // Two distinct calls to that host should still produce two REQUEST + two RESPONSE edges.
  const stripeReqs = graph.edges.filter(
    (e) => e.to === "external:api.stripe.com" && e.type === "REQUEST",
  );
  assert.equal(stripeReqs.length, 2);
});

test("case7 — URL to known internal container resolves to that container (not external)", () => {
  const graph = run(load("case7-internal-url.log"));
  // "payment" is a known container in this log (it writes its own entries),
  // so api's outgoing call to http://payment:8080/... must target the
  // container "payment" — NOT "external:payment".
  const externals = graph.services.filter((s) => s.kind === "external");
  assert.equal(externals.length, 0, `expected no external nodes, got: ${JSON.stringify(externals)}`);
  const paymentNode = graph.services.find((s) => s.name === "payment");
  assert.ok(paymentNode, "expected payment node present");
  assert.equal(paymentNode.kind, "container");
  const apiToPayment = graph.edges.find(
    (e) => e.from === "api" && e.to === "payment" && e.type === "REQUEST",
  );
  assert.ok(apiToPayment, "expected REQUEST edge api→payment");
});

test("case8 — real Graylog trace: service → service2 → external → service2 → service", () => {
  const raw = readFileSync(join(EXAMPLES, "case8-graylog-real.json"), "utf8");
  const messages = JSON.parse(raw) as MessageContent[];
  const graph = run(fromMessageContent(messages));

  // Expected causal chain
  const nonInferred = graph.edges.filter((e) => !e.type.startsWith("INFERRED"));
  const chain = nonInferred.map((e) => `${e.from}→${e.to}:${e.type}`);

  // service → service2 must exist (correlated by requestId)
  assert.ok(
    graph.edges.some((e) => e.from === "service" && e.to === "service2" && e.type === "REQUEST"),
    `missing service → service2 REQUEST. edges: ${chain.join(" | ")}`,
  );
  // service2 → external (the protocol-less URL resolves to external host)
  assert.ok(
    graph.edges.some(
      (e) => e.from === "service2" && e.to.startsWith("external:") && e.type === "REQUEST",
    ),
    `missing service2 → external REQUEST. edges: ${chain.join(" | ")}`,
  );
  // external → service2 (response from the third party)
  assert.ok(
    graph.edges.some(
      (e) => e.from.startsWith("external:") && e.to === "service2" && e.type === "RESPONSE",
    ),
    `missing external → service2 RESPONSE. edges: ${chain.join(" | ")}`,
  );
  // service2 → service (response back up the chain)
  assert.ok(
    graph.edges.some((e) => e.from === "service2" && e.to === "service" && e.type === "RESPONSE"),
    `missing service2 → service RESPONSE. edges: ${chain.join(" | ")}`,
  );

  // Services diagram shows service, service2 as containers + one external
  const kinds = new Map(graph.services.map((s) => [s.name, s.kind]));
  assert.equal(kinds.get("service"), "container");
  assert.equal(kinds.get("service2"), "container");
  const externals = graph.services.filter((s) => s.kind === "external");
  assert.equal(externals.length, 1, `expected 1 external node, got ${externals.length}`);
});

test("service kinds are classified correctly", () => {
  const graph = run(load("case6-third-party.log"));
  const kinds = new Map(graph.services.map((s) => [s.name, s.kind]));
  assert.equal(kinds.get("api"), "container");
  assert.equal(kinds.get("external:api.stripe.com"), "external");
  // By default there's no synthetic client node.
  assert.equal(kinds.get("client"), undefined);
});

test("case9 — OUT+IN paired by requestId merge into one edge (no external)", () => {
  const raw = readFileSync(join(EXAMPLES, "case9-paired-dedup.json"), "utf8");
  const messages = JSON.parse(raw) as MessageContent[];
  const graph = run(fromMessageContent(messages));

  // service1 logs an OUT to `http://some-random-hostname/...` AND service2
  // logs an IN with the same requestId. Without correlation we would emit
  // both `service1 → external:some-random-hostname` AND `service1 → service2`.
  // With correlation: OUT.receiver inferred = service2 → both edges become
  // `service1 → service2`, and dedup (same requestId) collapses them.
  const externals = graph.services.filter((s) => s.kind === "external");
  assert.equal(externals.length, 0, `no external nodes expected, got ${JSON.stringify(externals)}`);

  const req = graph.edges.filter(
    (e) => e.from === "service1" && e.to === "service2" && e.type === "REQUEST",
  );
  assert.equal(req.length, 1, `expected exactly 1 service1→service2 REQUEST, got ${req.length}`);

  const res = graph.edges.filter(
    (e) => e.from === "service2" && e.to === "service1" && e.type === "RESPONSE",
  );
  assert.equal(res.length, 1, `expected exactly 1 service2→service1 RESPONSE, got ${res.length}`);
});

test("includeClient: true restores synthetic client node (spec mode)", () => {
  const graph = run(load("case6-third-party.log"), { includeClient: true });
  const kinds = new Map(graph.services.map((s) => [s.name, s.kind]));
  assert.equal(kinds.get("client"), "client");
  assert.ok(
    graph.edges.some((e) => e.from === "client" && e.to === "api" && e.type === "REQUEST"),
  );
});
