import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseCardClick, FeishuChannel, httpKernelPort, type Lark } from "../src/channels/feishu/channel.ts";
import { renderCard, renderAnswered, parseButtonName } from "../src/channels/feishu/cards.ts";
import { route } from "../src/channels/feishu/commands.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { startApi } from "../src/kernel/api.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import type { Card } from "../src/kernel/types.ts";

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

test("表单按钮：按钮名带卡片编号和选项序号，form_value 带文字框和适用范围", () => {
  const c = parseCardClick({ ...ev, action_value: "", action_name: "xj_C_12_o1", form_value: JSON.stringify({ text: "按服务器时区", scope: "project" }) }, OWNER)!;
  assert.deepEqual([c.card_id, c.option_index, c.text, c.scope], ["C-12", 1, "按服务器时区", "project"]);
  const t = parseCardClick({ ...ev, action_name: "xj_C_3_text", form_value: JSON.stringify({ text: "都不对", scope: "乱填" }) }, OWNER)!;
  assert.deepEqual([t.card_id, t.option_index, t.text, t.scope], ["C-3", undefined, "都不对", undefined], "认不出的范围丢掉");
  assert.equal(parseButtonName("别的按钮"), null);
});

test("私聊一句话怎么分流：命令、中文关键词、其余直接立项", () => {
  assert.deepEqual(route("/card"), { kind: "cards" });
  assert.deepEqual(route("／cards"), { kind: "cards" }, "全角斜杠也认");
  assert.deepEqual(route("待办"), { kind: "cards" });
  assert.deepEqual(route("卡片？"), { kind: "cards" });
  assert.deepEqual(route("进度"), { kind: "status" });
  assert.deepEqual(route("/STATUS"), { kind: "status" });
  assert.deepEqual(route("卡片样式改成蓝色"), { kind: "goal", title: "卡片样式改成蓝色" }, "关键词要整条一致");
  assert.deepEqual(route("/goal /tmp 下清一下日志"), { kind: "goal", title: "/tmp 下清一下日志" });
  assert.deepEqual(route("/deploy"), { kind: "unknown", command: "/deploy" });
  assert.deepEqual(route("  "), { kind: "help" });
});

test("渲染：决策卡带文字框、适用范围和“用这句话回答”；审核卡只有文字框；知会卡没有按钮", () => {
  const base: Card = { id: "C-7", kind: "decision", about: "T-2", title: "时区按哪个", body: "b", dedupe_key: "k", status: "open",
    options: [{ key: "服务器", label: "服务器", recommended: true }, { key: "用户", label: "用户" }], answer: null, external_ref: null, created_at: "", updated_at: "" };
  const form = (c: Card) => ((renderCard(c).body as { elements: { tag: string; elements?: { tag: string; name: string; text?: { content: string } }[] }[] }).elements.find((e) => e.tag === "form"));
  const d = form(base)!.elements!;
  assert.deepEqual(d.map((e) => e.tag), ["input", "select_static", "button", "button", "button"]);
  assert.deepEqual(d.filter((e) => e.tag === "button").map((e) => e.name), ["xj_C_7_o0", "xj_C_7_o1", "xj_C_7_text"]);
  assert.equal(d[2]!.text!.content, "服务器（推荐）");
  const r = form({ ...base, kind: "review" })!.elements!;
  assert.deepEqual(r.map((e) => e.tag), ["input", "button", "button"]);
  assert.equal(form({ ...base, kind: "notice" }), undefined);
  const done = renderAnswered({ ...base, status: "answered", answer: { choice: "用户", text: "按用户所在地", scope: "project" } });
  assert.match(JSON.stringify(done), /结论\*\*：用户.*说明\*\*：按用户所在地.*适用范围\*\*：这个项目/);
});

// ---- 通道端到端：真的内核接口，假的飞书（只记下要发什么）----

class FakeLark implements Lark {
  cards: { card: Record<string, unknown>; key?: string | undefined }[] = [];
  texts: string[] = [];
  updates: { token: string; card: Record<string, unknown> }[] = [];
  private keys = new Set<string>();
  private n = 0;
  async sendCard(card: Record<string, unknown>, key?: string) {
    if (key && this.keys.has(key)) return `om_dup_${key}`;   // 飞书的幂等键：同一个键不重复发
    if (key) this.keys.add(key);
    this.cards.push({ card, key }); return `om_${++this.n}`;
  }
  async sendText(text: string, key?: string) { if (key && this.keys.has(key)) return; if (key) this.keys.add(key); this.texts.push(text); }
  async updateCard(token: string, card: Record<string, unknown>) { this.updates.push({ token, card }); }
}

async function setup() {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  const lark = new FakeLark();
  const channel = new FeishuChannel({ owner_open_id: OWNER, kernel: httpKernelPort(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), lark, log: () => {} });
  let n = 0;
  const say = (content: string, extra: Record<string, unknown> = {}) => channel.handle("im.message.receive_v1",
    JSON.stringify({ type: "im.message.receive_v1", message_id: `om_in_${++n}`, chat_type: "p2p", message_type: "text", sender_id: OWNER, content, ...extra }));
  const click = (name: string, form: Record<string, unknown> = {}) => channel.handle("card.action.trigger",
    JSON.stringify({ ...ev, event_id: `evt_${++n}`, token: `tok_${n}`, action_value: "", action_name: name, form_value: JSON.stringify(form) }));
  const close = () => new Promise<void>((r) => { server.close(() => r()); kernel.close(); });
  return { kernel, lark, channel, say, click, close };
}

const at = "2026-11-12T09:00:00.000Z";
function finishRound(k: Kernel, receipt: Record<string, unknown>) {
  const c = k.claim("claude", at, `claim-${Math.random()}`)!;
  k.ingest({ source: "worker", source_id: `r-${Math.random()}`, type: "run.receipt", at, payload: { run_id: c.run_id, task_id: c.task.id, session_id: "s1", receipt } });
}

test("飞书一轮：一句话立项 → 回执出审核卡 → 发 /card 收到卡片 → 在卡片上点接受 → 任务和目标 done，卡片原地改成结论", async () => {
  const h = await setup();
  try {
    await h.say("在 math.mjs 加一个 div 函数");
    assert.equal(h.kernel.overview().goals.length, 1);
    assert.match(h.lark.texts.at(-1)!, /^已立项 G-1 · T-1：在 math\.mjs 加一个 div 函数/);

    // 长连接重投同一条消息：不重复立项，不重复回复
    await h.channel.handle("im.message.receive_v1", JSON.stringify({ message_id: "om_in_1", chat_type: "p2p", message_type: "text", sender_id: OWNER, content: "在 math.mjs 加一个 div 函数" }));
    assert.equal(h.kernel.overview().goals.length, 1); assert.equal(h.lark.texts.length, 1);
    // 别人的消息、群里的消息都不算
    await h.say("帮我删库", { sender_id: "ou_stranger" });
    await h.say("群里说的", { chat_type: "group" });
    assert.equal(h.kernel.overview().goals.length, 1);

    finishRound(h.kernel, { outcome: "done", summary: "div 加好了", handoff: "见 math.mjs", found: [{ title: "没有测试" }] });
    await h.channel.pushPending();
    assert.equal(h.lark.cards.length, 0, "审核卡不主动推送");

    await h.say("/card");
    assert.equal(h.lark.cards.length, 1, "只发要你处理的那张，知会卡只列标题");
    assert.match(JSON.stringify(h.lark.cards[0]!.card), /"name":"xj_C_1_o0"/);
    assert.match(h.lark.texts.at(-1)!, /以上 1 张卡片待你处理。\n知会 1 条（不需要动作）：\n· C-2 发现：没有测试/);
    assert.equal(h.kernel.card("C-1")!.external_ref, "om_1", "送达记账");

    await h.click("xj_C_1_o0", { text: "" });
    const o = h.kernel.overview();
    assert.equal(o.tasks[0]!.state, "done"); assert.equal((o.goals[0] as { status: string }).status, "done");
    assert.equal(h.kernel.card("C-1")!.answer!.choice, "accept");
    assert.match(JSON.stringify(h.lark.updates[0]!.card), /"template":"green".*结论\*\*：接受/);

    // 再点一次（或点旧卡片）：不再记账，卡片仍显示账本里的结论
    const before = h.kernel.why("C-1").length;
    await h.click("xj_C_1_o2", {});
    assert.equal(h.kernel.why("C-1").length, before);
    assert.match(JSON.stringify(h.lark.updates[1]!.card), /结论\*\*：接受/);

    await h.say("/status");
    assert.match(h.lark.texts.at(-1)!, /需要你：没有；另有 1 张知会卡[\s\S]*G-1 \[done\]/);
  } finally { await h.close(); }
});

test("决策卡：主动推送一次；用文字框回答并选适用范围，落成定论，回答带进下一轮", async () => {
  const h = await setup();
  try {
    await h.say("给 greet 定语言");
    finishRound(h.kernel, { outcome: "ask", summary: "要定", ask: [{ question: "问候语用中文还是英文", options: ["中文", "英文"], recommended: "中文" }] });
    await h.channel.pushPending();
    await h.channel.pushPending();
    assert.equal(h.lark.cards.length, 1, "决策卡推一次，不重发");

    await h.click("xj_C_1_text", { text: "  " });
    assert.equal(h.kernel.card("C-1")!.status, "open", "空文字不算回答");
    assert.match(h.lark.texts.at(-1)!, /要先在文字框里写一句话/);

    await h.click("xj_C_1_text", { text: "中英双语，中文在前", scope: "project" });
    const card = h.kernel.card("C-1")!;
    assert.deepEqual(card.answer, { text: "中英双语，中文在前", scope: "project" });
    const ruling = h.kernel.db.prepare("SELECT scope, text FROM rulings").get() as { scope: string; text: string };
    assert.deepEqual({ ...ruling }, { scope: "project", text: "中英双语，中文在前" });
    const next = h.kernel.claim("claude", at, "next")!;
    assert.match(next.feedback!, /的回答：中英双语，中文在前$/);
    assert.match(JSON.stringify(h.lark.updates.at(-1)!.card), /说明\*\*：中英双语，中文在前.*适用范围\*\*：这个项目/);
  } finally { await h.close(); }
});

test("审核卡退回并附意见：意见作为下一轮的反馈", async () => {
  const h = await setup();
  try {
    await h.say("加 div");
    finishRound(h.kernel, { outcome: "done", summary: "好了", handoff: "h" });
    await h.click("xj_C_1_o1", { text: "除以 0 要报错" });
    assert.equal(h.kernel.task("T-1")!.state, "queued");
    assert.match(h.kernel.claim("claude", at, "again")!.feedback!, /审核退回（C-1）：除以 0 要报错/);
  } finally { await h.close(); }
});

test("不认识的命令和非文字消息回用法，不立项", async () => {
  const h = await setup();
  try {
    await h.say("/deploy");
    await h.say("[图片]", { message_type: "image" });
    assert.equal(h.kernel.overview().goals.length, 0);
    assert.match(h.lark.texts[0]!, /不认识的命令 \/deploy/);
    assert.match(h.lark.texts[1]!, /只认文字消息/);
  } finally { await h.close(); }
});

// ---- 2026-11-12 飞书真实一轮录下的事件（token 已打码、卡片原文已去掉）----
const realLines = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");

test("真实点击：表单按钮带 action_name 和 form_value，没有 action_value；三次点击都解析成卡片编号和选项序号", () => {
  const clicks = realLines("feishu-real-clicks.ndjson").map((l) => parseCardClick(JSON.parse(l), OWNER)!);
  assert.deepEqual(clicks.map((c) => [c.card_id, c.option_index, c.text, c.scope]), [
    ["C-12", 0, "", undefined],            // 审核卡：接受，没有适用范围
    ["C-13", 0, "", "task"],               // 决策卡：中文，适用范围下拉框的默认值随表单交上来
    ["C-14", 0, "", undefined],            // 审核卡：接受
  ]);
});

test("真实消息：私聊文字的 content 是纯文本；立项、/card、/status 各自分流，重投不重复立项", async () => {
  const h = await setup();
  try {
    const msgs = realLines("feishu-real-messages.ndjson");
    assert.deepEqual(msgs.map((l) => route(JSON.parse(l).content).kind), ["goal", "cards", "goal", "cards", "status"]);
    for (const l of msgs) await h.channel.handle("im.message.receive_v1", l);
    for (const l of msgs) await h.channel.handle("im.message.receive_v1", l);   // 长连接整批重投
    const goals = h.kernel.overview().goals as { title: string }[];
    assert.equal(goals.length, 2);
    assert.ok(goals[0]!.title.startsWith("在 math.mjs 新增并导出函数 div(a, b)") && goals[1]!.title.startsWith("在 math.mjs 新增并导出 greet2(name)"));
    assert.match(h.lark.texts[0]!, /^已立项 G-1 · T-1：在 math\.mjs 新增并导出函数 div/);
    assert.equal(h.lark.texts.length, 5, "每条消息只回一次");
  } finally { await h.close(); }
});
