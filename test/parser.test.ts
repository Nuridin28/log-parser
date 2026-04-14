import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines } from "../src/parser.ts";

test("parser extracts timestamp, level, container, message", () => {
  const lines = ["[10:00:01.123] INFO api Incoming request: POST /api/url"];
  const [ev] = parseLines(lines);
  assert.ok(ev);
  assert.equal(ev.level, "INFO");
  assert.equal(ev.container, "api");
  assert.equal(ev.message, "Incoming request: POST /api/url");
  assert.ok(typeof ev.timestamp === "number" && ev.timestamp > 0);
});

test("parser handles missing container", () => {
  const lines = ["[10:00:01.123] INFO Startup complete"];
  const [ev] = parseLines(lines);
  assert.ok(ev);
  assert.equal(ev.container, null);
  assert.equal(ev.message, "Startup complete");
});

test("parser skips blank lines", () => {
  const events = parseLines(["", "   ", "[10:00:00] INFO a msg"]);
  assert.equal(events.length, 1);
});

test("parser is total — accepts malformed lines", () => {
  const [ev] = parseLines(["not a valid log line at all"]);
  assert.ok(ev);
  assert.equal(ev.timestamp, null);
  assert.equal(ev.message, "not a valid log line at all");
});
