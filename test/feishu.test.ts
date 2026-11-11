import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCardClick } from "../src/channels/feishu/channel.ts";

const ev = JSON.parse(readFileSync(new URL("./fixtures/feishu-card-click.json", import.meta.url), "utf8"));
const OWNER = "ou_00000000000000000000000000000001";

test("实测录下的卡片点击：只认本人，action_value 是 JSON 字符串", () => {
  // 探针卡的 value 没有 card_id，所以按约定被忽略
  assert.equal(parseCardClick(ev, OWNER), null);
  const real = { ...ev, action_value: JSON.stringify({ card_id: "C-1", choice: "accept" }) };
  const c = parseCardClick(real, OWNER)!;
  assert.equal(c.card_id, "C-1"); assert.equal(c.choice, "accept"); assert.equal(c.message_id, ev.message_id);
  assert.equal(parseCardClick(real, "ou_someone_else"), null);
});
