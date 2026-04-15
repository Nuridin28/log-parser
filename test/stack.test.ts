import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "../src/types.ts";
import { buildEdges } from "../src/stack.ts";

let counter = 0;
function ev(over: Partial<Event> & { type: Event["type"]; service: string }): Event {
  counter += 1;
  return {
    id: over.id ?? `e${counter}`,
    timestamp: over.timestamp ?? 0,
    service: over.service,
    container: over.service,
    type: over.type,
    method: over.method ?? null,
    url: over.url ?? null,
    status: over.status ?? null,
    sender: over.sender ?? null,
    receiver: over.receiver ?? null,
    requestId: over.requestId ?? null,
    resolvedPeer: over.resolvedPeer ?? over.receiver ?? null,
    isPaired: over.isPaired ?? false,
    message: over.message ?? "",
    raw: over.raw ?? "",
    lineNo: 0,
  };
}

test("single IN+RESPONSE pair yields 2 edges (with includeClient)", () => {
  const events = [
    ev({ type: "IN", service: "api", method: "GET", url: "/x" }),
    ev({ type: "RESPONSE", service: "api", status: 200, url: "/x", timestamp: 1 }),
  ];
  const { edges } = buildEdges(events, { includeClient: true });
  assert.equal(edges.length, 2);
  assert.equal(edges[0]!.type, "REQUEST");
  assert.equal(edges[1]!.type, "RESPONSE");
});

test("single IN without sender yields 0 edges (default: no client)", () => {
  const events = [
    ev({ type: "IN", service: "api", method: "GET", url: "/x" }),
    ev({ type: "RESPONSE", service: "api", status: 200, url: "/x", timestamp: 1 }),
  ];
  const { edges } = buildEdges(events);
  // No visible caller → entry is a root frame; no edges at all.
  assert.equal(edges.length, 0);
});

test("backtracking fills in skipped responses", () => {
  const events = [
    ev({ type: "IN", service: "A", sender: "A", receiver: "B", url: "/1" }),
    ev({ type: "OUT", service: "B", sender: "B", receiver: "C", url: "/2", timestamp: 1 }),
    ev({ type: "OUT", service: "C", sender: "C", receiver: "D", url: "/3", timestamp: 2 }),
    ev({
      type: "RESPONSE",
      service: "B",
      sender: "D",
      receiver: "B",
      status: 200,
      timestamp: 10,
    }),
  ];
  const { edges } = buildEdges(events);
  const types = edges.map((e) => e.type);
  assert.ok(types.includes("INFERRED_RESPONSE"), `got ${types.join(",")}`);
});

test("orphan RESPONSE synthesizes INFERRED_REQUEST", () => {
  const events = [
    ev({
      type: "RESPONSE",
      service: "api",
      status: 200,
      url: "https://ip/url",
      // In the real pipeline virtualize() would populate resolvedPeer;
      // the stack test calls buildEdges directly, so set it by hand.
      resolvedPeer: "external:ip",
    }),
  ];
  const { edges } = buildEdges(events);
  assert.ok(edges.some((e) => e.type === "INFERRED_REQUEST"));
  assert.ok(edges.some((e) => e.type === "RESPONSE"));
});
