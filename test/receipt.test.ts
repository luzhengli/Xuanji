import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/kernel/receipt.ts";

test("裸 JSON 回执", () => {
  const r = parseReceipt('{"outcome":"nothing","summary":"probe ok"}');
  assert.ok(r.ok); assert.equal(r.receipt.outcome, "nothing");
});

test("围栏里的回执，前面有闲话", () => {
  const r = parseReceipt('做完了。\n```json\n{"outcome":"done","summary":"x","handoff":"停在 a.ts"}\n```');
  assert.ok(r.ok); assert.equal(r.receipt.handoff, "停在 a.ts");
});

test("done 没有 handoff 不算合法", () => {
  const r = parseReceipt('{"outcome":"done","summary":"x"}');
  assert.ok(!r.ok); assert.match(r.error, /handoff/);
});

test("ask 必须带问题", () => {
  assert.ok(!parseReceipt('{"outcome":"ask","summary":"x","ask":[]}').ok);
  assert.ok(parseReceipt('{"outcome":"ask","summary":"x","ask":[{"question":"改列吗"}]}').ok);
});
