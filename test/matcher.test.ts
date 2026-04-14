import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "../src/types.ts";
import { score, bestMatch } from "../src/matcher.ts";

function ev(over: Partial<Event>): Event {
  return {
    id: "x",
    timestamp: 0,
    service: "",
    container: null,
    type: "UNKNOWN",
    method: null,
    url: null,
    status: null,
    sender: null,
    receiver: null,
    requestId: null,
    message: "",
    raw: "",
    lineNo: 0,
    ...over,
  };
}

test("matches on requestId regardless of other fields", () => {
  const a = ev({ requestId: "r1", service: "api", timestamp: 0 });
  const b = ev({ requestId: "r1", service: "payment", timestamp: 10000 });
  assert.ok(score(a, b) >= 0.4);
});

test("matches on sender/receiver swap", () => {
  const a = ev({ sender: "api", receiver: "payment", timestamp: 0 });
  const b = ev({ sender: "payment", receiver: "api", timestamp: 100 });
  assert.ok(score(a, b) >= 0.2);
});

test("time proximity contributes at most 0.1", () => {
  const a = ev({ timestamp: 0 });
  const b = ev({ timestamp: 1000 });
  assert.ok(score(a, b) <= 0.1 + 1e-9);
});

test("bestMatch returns null when score is below threshold", () => {
  const a = ev({ service: "x", timestamp: 0 });
  const response = ev({ service: "y", timestamp: 10_000_000 });
  const { match } = bestMatch(response, [a], { min: 0.3 });
  assert.equal(match, null);
});
