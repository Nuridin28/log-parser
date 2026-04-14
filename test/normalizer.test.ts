import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines } from "../src/parser.ts";
import { normalize, resetIds } from "../src/normalizer.ts";

test("normalizer extracts method + url from plain text", () => {
  resetIds();
  const [ev] = normalize(parseLines(["[10:00:01.123] INFO api Incoming request: POST /api/url"]));
  assert.ok(ev);
  assert.equal(ev.method, "POST");
  assert.equal(ev.url, "/api/url");
  assert.equal(ev.service, "api");
});

test("normalizer extracts from JSON blob", () => {
  resetIds();
  const [ev] = normalize(
    parseLines([
      '[10:00:01.200] INFO api Proxy Outgoing Request {"request":{"url":"https://ip/url","method":"POST"}}',
    ]),
  );
  assert.ok(ev);
  assert.equal(ev.method, "POST");
  assert.equal(ev.url, "https://ip/url");
});

test("normalizer extracts from key=value", () => {
  resetIds();
  const [ev] = normalize(
    parseLines(["[10:00:04.000] INFO api sender=api receiver=payment method=POST url=/pay"]),
  );
  assert.ok(ev);
  assert.equal(ev.sender, "api");
  assert.equal(ev.receiver, "payment");
  assert.equal(ev.method, "POST");
  assert.equal(ev.url, "/pay");
});

test("normalizer extracts status code", () => {
  resetIds();
  const [ev] = normalize(parseLines(["[10:00:01.500] INFO payment http_status=200"]));
  assert.ok(ev);
  assert.equal(ev.status, 200);
});
