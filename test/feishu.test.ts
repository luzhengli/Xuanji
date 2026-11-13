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
    options: [{ key: "服务器", label: "服务器", recommended: true }, { key: "用户", label: "用户" }], answer: null, external_ref: null, form: null, created_at: "", updated_at: "" };
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
  patches: { messageId: string; card: Record<string, unknown> }[] = [];
  failPatch = false;
  async patchCard(messageId: string, card: Record<string, unknown>) { if (this.failPatch) throw new Error("超过 14 天"); this.patches.push({ messageId, card }); }
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
// 主理人交一份草稿（代替接单程序起 Claude Code）。
function principal(k: Kernel, output: Record<string, unknown>) {
  const j = k.claimJudgment("claude", at, `j-${Math.random()}`)!;
  k.ingest({ source: "worker", source_id: `jr-${Math.random()}`, type: "judgment.result", at, about: j.about, payload: { judgment_id: j.id, output } });
  return j;
}
// 直接立项（这几个用例看的是卡片，不是主理人）。
const directGoal = (k: Kernel, title: string) => k.ingest({ source: "cli", source_id: `g-${Math.random()}`, type: "goal.confirmed", at, payload: { title } });
function finishRound(k: Kernel, receipt: Record<string, unknown>) {
  const c = k.claim("claude", at, `claim-${Math.random()}`)!;
  k.ingest({ source: "worker", source_id: `r-${Math.random()}`, type: "run.receipt", at, payload: { run_id: c.run_id, task_id: c.task.id, session_id: "s1", receipt } });
}

test("飞书一轮：一句话 → 主理人出目标卡并推来 → 确认立项 → 回执出审核卡 → /card 取卡 → 点接受 → done，卡片原地改成结论", async () => {
  const h = await setup();
  try {
    await h.say("在 math.mjs 加一个 div 函数");
    assert.deepEqual(h.kernel.overview().goals.map((g) => (g as { status: string }).status), ["proposed"]);
    assert.equal(h.kernel.overview().tasks.length, 0, "确认之前不立任务");
    assert.match(h.lark.texts.at(-1)!, /^收到（G-1）。主理人整理好目标卡就发给你确认/);

    // 长连接重投同一条消息：不重复记，不重复回复
    await h.channel.handle("im.message.receive_v1", JSON.stringify({ message_id: "om_in_1", chat_type: "p2p", message_type: "text", sender_id: OWNER, content: "在 math.mjs 加一个 div 函数" }));
    assert.equal(h.kernel.overview().goals.length, 1); assert.equal(h.lark.texts.length, 1);
    // 别人的消息、群里的消息都不算
    await h.say("帮我删库", { sender_id: "ou_stranger" });
    await h.say("群里说的", { chat_type: "group" });
    assert.equal(h.kernel.overview().goals.length, 1);

    principal(h.kernel, { kind: "goal", direct: false, title: "math.mjs 新增 div(a, b)", acceptance: ["div(6, 3) 返回 2", "除以 0 抛错"], boundaries: ["只改 math.mjs"], ask_first: [] });
    await h.channel.pushPending();
    assert.equal(h.lark.cards.length, 1, "目标卡主动推来");
    const goalCard = JSON.stringify(h.lark.cards[0]!.card);
    assert.match(goalCard, /目标卡：math\.mjs 新增 div\(a, b\)/);
    assert.match(goalCard, /验收\*\*\\n- div\(6, 3\) 返回 2\\n- 除以 0 抛错/);
    assert.match(goalCard, /L1 做到可审核为止，可推分支、开 PR · 预算 8 轮或 2 小时/);
    assert.doesNotMatch(goalCard, /select_static|用上面这句话回答/, "目标卡没有适用范围，也没有“用这句话回答”");

    await h.click("xj_C_1_o0", {});        // 确认
    const goals = h.kernel.overview().goals as { id: string; title: string; status: string }[];
    assert.deepEqual([goals[0]!.status, goals[0]!.title], ["active", "math.mjs 新增 div(a, b)"]);
    assert.deepEqual(h.kernel.task("T-1")!.contract.acceptance.criteria, ["div(6, 3) 返回 2", "除以 0 抛错"], "验收标准进了任务契约");
    assert.match(JSON.stringify(h.lark.updates[0]!.card), /结论\*\*：确认/);

    finishRound(h.kernel, { outcome: "done", summary: "div 加好了", handoff: "见 math.mjs", found: [{ title: "没有测试" }] });
    await h.channel.pushPending();
    assert.equal(h.lark.cards.length, 1, "审核卡不主动推送");

    await h.say("/card");
    assert.equal(h.lark.cards.length, 2, "只发要你处理的那张，知会卡只列标题");
    assert.match(JSON.stringify(h.lark.cards[1]!.card), /"name":"xj_C_2_o0"/);
    assert.match(h.lark.texts.at(-1)!, /以上 1 张卡片待你处理。\n知会 1 条（不需要动作）：\n· C-3 发现：没有测试/);
    assert.equal(h.kernel.card("C-2")!.external_ref, "om_2", "送达记账");

    await h.click("xj_C_2_o0", { text: "" });
    const o = h.kernel.overview();
    assert.equal(o.tasks[0]!.state, "done"); assert.equal((o.goals[0] as { status: string }).status, "done");
    assert.equal(h.kernel.card("C-2")!.answer!.choice, "accept");
    assert.match(JSON.stringify(h.lark.updates[1]!.card), /"template":"green".*结论\*\*：接受/);

    // 再点一次（或点旧卡片）：不再记账，卡片仍显示账本里的结论
    const before = h.kernel.why("C-2").length;
    await h.click("xj_C_2_o2", {});
    assert.equal(h.kernel.why("C-2").length, before);
    assert.match(JSON.stringify(h.lark.updates[2]!.card), /结论\*\*：接受/);

    await h.say("/status");
    // /status 回一张分段的卡片（2026-11-13 改）：每段一个元素，状态用中文。
    const status = h.lark.cards.at(-1)!.card as { header: { title: { content: string } }; body: { elements: { content: string }[] } };
    assert.equal(status.header.title.content, "状态");
    assert.deepEqual(status.body.elements.map((e) => e.content.split("\n")[0]), ["**需要你**", "**在做**", "**最近结束**", "**名额（在跑/上限）**"]);
    assert.equal(status.body.elements[0]!.content, "**需要你**\n- 没有\n- 知会 1 张，不用动作");
    assert.match(status.body.elements[2]!.content, /- G-1 完成：/);
  } finally { await h.close(); }
});

test("决策卡：主动推送一次；用文字框回答并选适用范围，落成定论，回答带进下一轮", async () => {
  const h = await setup();
  try {
    directGoal(h.kernel, "给 greet 定语言");
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
    directGoal(h.kernel, "加 div");
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

test("真实消息：私聊文字的 content 是纯文本；说目标、/card、/status 各自分流，重投不重复记", async () => {
  const h = await setup();
  try {
    const msgs = realLines("feishu-real-messages.ndjson");
    assert.deepEqual(msgs.map((l) => route(JSON.parse(l).content).kind), ["goal", "cards", "goal", "cards", "status"]);
    for (const l of msgs) await h.channel.handle("im.message.receive_v1", l);
    for (const l of msgs) await h.channel.handle("im.message.receive_v1", l);   // 长连接整批重投
    const goals = h.kernel.overview().goals as { title: string; status: string }[];
    assert.equal(goals.length, 2);
    assert.ok(goals[0]!.title.startsWith("在 math.mjs 新增并导出函数 div(a, b)") && goals[1]!.title.startsWith("在 math.mjs 新增并导出 greet2(name)"));
    assert.deepEqual(goals.map((g) => g.status), ["proposed", "proposed"], "交给主理人整理，等人确认");
    assert.match(h.lark.texts[0]!, /^收到（G-1）/);
    assert.equal(h.lark.texts.length + h.lark.cards.length, 5, "每条消息只回一次（/status 回的是卡片）");
  } finally { await h.close(); }
});

// ---- P1-10 / P1-13 / P1-17 在飞书上的样子 ----

test("目标卡点“修改”不写意见：提示先写，不记账；写了意见再点，交给主理人重整", async () => {
  const h = await setup();
  try {
    await h.say("加 div");
    principal(h.kernel, { kind: "goal", direct: false, title: "div", acceptance: ["能除"] });
    await h.click("xj_C_1_o1", { text: " " });
    assert.equal(h.kernel.card("C-1")!.status, "open");
    assert.match(h.lark.texts.at(-1)!, /C-1：点“修改”之前，要先在文字框里写一句话。/);
    await h.click("xj_C_1_o1", { text: "除以 0 要报错" });
    assert.equal(h.kernel.card("C-1")!.answer!.choice, "revise");
    assert.equal(h.kernel.judgment("J-2")!.input.feedback, "除以 0 要报错");
    assert.match(JSON.stringify(h.lark.updates.at(-1)!.card), /结论\*\*：修改.*说明\*\*：除以 0 要报错/);
  } finally { await h.close(); }
});

test("推送：目标卡、主理人的答复、简报、超预算卡推；审核卡和普通知会卡不推", async () => {
  const h = await setup();
  try {
    await h.say("你好");
    principal(h.kernel, { kind: "not_goal", reply: "你好，有事直接说。" });          // C-1 答复，推
    await h.say("加 div");
    principal(h.kernel, { kind: "goal", direct: true, title: "div", acceptance: ["能除"] }); // C-2 已立项，推
    finishRound(h.kernel, { outcome: "done", summary: "好了", handoff: "h", found: [{ title: "没测试" }] });  // C-3 审核、C-4 知会，不推
    await h.channel.pushPending();
    const titles = () => h.lark.cards.map((c) => (c.card.header as { title: { content: string } }).title.content);
    assert.deepEqual(titles(), ["主理人：你好，有事直接说。", "已立项 G-2 · T-1：div"]);

    await h.say("简报");
    assert.equal(titles().at(-1), `简报 ${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`);
    const body = JSON.stringify(h.lark.cards.at(-1)!.card);
    assert.match(body, /审核 1 张/);
    assert.match(body, /知会\*\* 3 条（已收起）/, "两条答复和一条发现都收起");
    assert.equal(h.kernel.card("C-4")!.status, "folded");
    await h.say("/card");
    assert.doesNotMatch(h.lark.texts.at(-1)!, /C-4/, "收起的知会卡不再列出");
  } finally { await h.close(); }
});

test("超预算卡：推来，没有适用范围；点“追加”回队列", async () => {
  const h = await setup();
  try {
    h.kernel.ingest({ source: "cli", source_id: "g-budget", type: "goal.confirmed", at, payload: { title: "x", grant: { budget: { runs: 1, minutes: 120 } } } });
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "甲还是乙", options: ["甲", "乙"] }] });
    await h.click("xj_C_1_o0", {});
    await h.channel.pushPending();
    const budget = h.lark.cards.find((c) => /超出预算/.test(JSON.stringify(c.card)))!;
    const json = JSON.stringify(budget.card);
    assert.match(json, /"content":"追加 4 轮和 1 小时"[\s\S]*"content":"停掉（推荐）"[\s\S]*"content":"接管"/);
    assert.doesNotMatch(json, /select_static|用上面这句话回答/);
    await h.click("xj_C_2_o0", {});
    assert.equal(h.kernel.task("T-1")!.state, "queued");
    assert.equal(h.kernel.task("T-1")!.contract.budget.runs, 5);
  } finally { await h.close(); }
});

test("/stop T-x：叫停任务并回一句；格式不对回用法", async () => {
  const h = await setup();
  try {
    directGoal(h.kernel, "x");
    await h.say("/stop t-1");
    assert.equal(h.kernel.task("T-1")!.state, "stopped");
    assert.match(h.lark.texts.at(-1)!, /已叫停 T-1（现在 stopped）/);
    assert.deepEqual(route("/stop"), { kind: "help" });
    assert.deepEqual(route("/brief"), { kind: "brief" });
  } finally { await h.close(); }
});

test("真实点击（2026-11-12 第二轮）：目标卡文字框写了字再点“修改”，form_value 带着这句话；超预算卡、审核卡没有适用范围", () => {
  const clicks = realLines("feishu-real-clicks-p1-10.ndjson").map((l) => parseCardClick(JSON.parse(l), OWNER)!);
  assert.deepEqual(clicks.map((c) => [c.card_id, c.option_index, c.text, c.scope]), [
    ["C-16", 1, "验收加一条：pow(2, 10) 返回 1024", undefined],   // 目标卡：修改，带意见
    ["C-17", 0, "", undefined],                                   // 目标卡：确认
    ["C-18", 0, "", "task"],                                      // 普通决策卡：带适用范围
    ["C-21", 0, "", undefined],                                   // 超预算卡：追加
    ["C-22", 0, "", undefined],                                   // 审核卡：接受
  ]);
});

test("目标卡正文各段之间空一行（飞书 markdown 不空行会把下一段标题接到上一条列表末尾）", async () => {
  const { goalCardBody } = await import("../src/kernel/intake.ts");
  const body = goalCardBody({ acceptance: ["a"], boundaries: ["b"], grant: { level: "L1", effects: [], budget: { runs: 8, minutes: 120 }, ask_first: [] } }, ["n"]);
  assert.equal(body, "**提醒**\n- n\n\n**验收**\n- a\n\n**边界**\n- b\n\n**授权** L1 做到可审核为止 · 预算 8 轮或 2 小时 · 先问：不可逆或授权外的对外动作");
});

test("P1-25：内核重启那几秒里到的消息不丢：通道用同一个来源编号重试，内核回来后只记一次", async () => {
  const probe = (await import("node:net")).createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const lark = new FakeLark();
  const channel = new FeishuChannel({ owner_open_id: OWNER, kernel: httpKernelPort(`http://127.0.0.1:${port}`, [100, 100, 200, 400, 800]), lark, log: () => {} });
  const msg = JSON.stringify({ message_id: "om_down", chat_type: "p2p", message_type: "text", sender_id: OWNER, content: "内核停着时说的话" });
  const pending = channel.handle("im.message.receive_v1", msg);
  await new Promise((r) => setTimeout(r, 300));
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, port);
  await once(server, "listening");
  try {
    await pending;
    assert.equal(kernel.overview().goals.length, 1, "内核回来后入账");
    assert.match(lark.texts[0]!, /^收到（G-1）/);
    await channel.handle("im.message.receive_v1", msg);
    assert.equal(kernel.overview().goals.length, 1, "重投不重复记");
  } finally { server.close(); kernel.close(); }
});

test("撤回的卡片被点到时原地改成“已撤回”（灰色），不再显示成已回答", () => {
  const base: Card = { id: "C-7", kind: "decision", about: "G-1", title: "目标卡：pow", body: "b", dedupe_key: "k", status: "withdrawn",
    options: [], answer: null, external_ref: null, form: "goal", created_at: "", updated_at: "" };
  const json = JSON.stringify(renderAnswered(base));
  assert.match(json, /C-7 · 已撤回/);
  assert.match(json, /"template":"grey"/);
  assert.match(json, /已撤回\*\*：情况变了/);
});

test("P1-27 撤回、收起、在 xj 里回答了的卡片，通道主动在飞书上改成现状；每个状态只改一次，改不成也不反复试", async () => {
  const h = await setup();
  try {
    directGoal(h.kernel, "加 div");
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "除以 0 怎么办", options: ["抛错", "返回 NaN"] }] });
    directGoal(h.kernel, "加 mod");
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "负数取模按哪种", options: ["数学", "JS"] }] });
    await h.channel.pushPending();
    assert.equal(h.lark.cards.length, 2, "两张决策卡推来");
    await h.channel.refreshClosed();
    assert.equal(h.lark.patches.length, 0, "都还开着，不用改");

    // C-1 在 xj 里回答（飞书上没点）；C-2 因为任务被叫停而撤回。
    h.kernel.ingest({ source: "cli", source_id: "ans-1", type: "card.answered", at, payload: { card_id: "C-1", choice: "抛错" } });
    h.kernel.ingest({ source: "cli", source_id: "stop-2", type: "human.stop", at, payload: { about: "T-2" } });
    await h.channel.refreshClosed();
    assert.deepEqual(h.lark.patches.map((p) => p.messageId), ["om_1", "om_2"]);
    assert.match(JSON.stringify(h.lark.patches[0]!.card), /C-1 · 已回答.*结论\*\*：抛错/);
    assert.match(JSON.stringify(h.lark.patches[1]!.card), /C-2 · 已撤回.*已撤回\*\*：情况变了/);
    assert.doesNotMatch(JSON.stringify(h.lark.patches[1]!.card), /"tag":"button"/, "改过的卡片没有按钮");
    await h.channel.refreshClosed();
    assert.equal(h.lark.patches.length, 2, "同一状态不再改第二次");
    assert.deepEqual(h.kernel.why("C-2").map((e) => e.type).slice(-1), ["card.refreshed"]);

    // 改不成（超过 14 天等）：记下，不反复重试。
    directGoal(h.kernel, "加 abs");
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "abs(-0) 返回什么", options: ["0", "-0"] }] });
    await h.channel.pushPending();
    h.kernel.ingest({ source: "cli", source_id: "stop-3", type: "human.stop", at, payload: { about: h.kernel.card("C-3")!.about } });
    h.lark.failPatch = true;
    await h.channel.refreshClosed();
    await h.channel.refreshClosed();
    assert.equal(h.kernel.staleCards().length, 0);
    assert.match(h.kernel.why("C-3").at(-1)!.note ?? "", /飞书上没改成：超过 14 天/);

    // 在飞书上点的：点击时已原地改好，不再补改。
    h.lark.failPatch = false;
    directGoal(h.kernel, "加 sign");
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "sign(0) 返回什么", options: ["0", "1"] }] });
    await h.channel.pushPending();
    await h.click("xj_C_4_o0", {});
    await h.channel.refreshClosed();
    assert.equal(h.lark.patches.length, 2, "点击过的卡片不补改");
  } finally { await h.close(); }
});

// ---- P2-07 定论簿：/rulings 回一张卡，每条一个“作废”按钮；点了落 ruling.revoked，卡片原地改成剩下的 ----
test("P2-07：/rulings 列出生效中的定论，点“作废”落账并原地更新；没有定论时回一句话", async () => {
  const h = await setup();
  try {
    assert.deepEqual(route("/rulings"), { kind: "rulings" });
    assert.deepEqual(route("定论"), { kind: "rulings" });
    await h.say("/rulings");
    assert.match(h.lark.texts.at(-1)!, /没有生效中的定论/);

    // 两张决策卡，回答时选了范围，落成两条定论。
    h.kernel.ingest({ source: "cli", source_id: "g-r1", type: "goal.confirmed", at, payload: { title: "加 mod" } });
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "负数取模按哪种", options: ["数学", "JS"] }] });
    h.kernel.ingest({ source: "cli", source_id: "a-r1", type: "card.answered", at, payload: { card_id: "C-1", choice: "数学", scope: "project" } });
    h.kernel.ingest({ source: "cli", source_id: "g-r2", type: "goal.confirmed", at, payload: { title: "加 abs" } });
    finishRound(h.kernel, { outcome: "ask", summary: "要问", ask: [{ question: "abs(-0)", options: ["0"] }] });
    h.kernel.ingest({ source: "cli", source_id: "a-r2", type: "card.answered", at, payload: { card_id: "C-2", choice: "0", text: "返回 0，不要 -0", scope: "global" } });

    await h.say("/rulings");
    const card = JSON.stringify(h.lark.cards.at(-1)!.card);
    assert.match(card, /定论簿/);
    assert.match(card, /\*\*R-1\*\*（这个项目 · 2026-11-12 · 出处 C-1 · T-1）\\n负数取模按哪种 → 数学/);
    assert.match(card, /\*\*R-2\*\*（以后都这样.*\\n返回 0，不要 -0/);
    assert.match(card, /"name":"xj_rv_R_1".*"content":"作废 R-1"/);

    await h.click("xj_rv_R_1");
    assert.deepEqual(h.kernel.rulings().map((r) => r.id), ["R-2"]);
    assert.equal(h.kernel.rulings(true).find((r) => r.id === "R-1")!.revoked, true);
    const updated = JSON.stringify(h.lark.updates.at(-1)!.card);
    assert.match(updated, /已作废 R-1，以后不再注入/);
    assert.doesNotMatch(updated, /xj_rv_R_1/);
    await h.click("xj_rv_R_1");   // 再点一次：已作废，不再动
    assert.equal(h.kernel.why("R-1").filter((e) => e.type === "ruling.revoked").length, 2);
    assert.equal(h.kernel.why("R-1").filter((e) => e.note === "人作废了这条定论").length, 1);
    // 别人点的不算。
    await h.channel.handle("card.action.trigger", JSON.stringify({ ...ev, operator_id: "ou_other", event_id: "evt_x", action_name: "xj_rv_R_2" }));
    assert.deepEqual(h.kernel.rulings().map((r) => r.id), ["R-2"]);
  } finally { await h.close(); }
});

test("卡片正文按空行拆成几个 markdown 元素：飞书在同一个元素里列表后空一行也会把下一段压到最后一项上（2026-11-13 人截图 C-42）", () => {
  const card = { id: "C-9", kind: "review", about: "T-1", title: "审核：x", body: "**残余风险**\n- a\n- b\n\n**结果**\n- 分支 `xj/T-1`\n\n\n**执行者说明**\n好了", options: [{ key: "accept", label: "接受" }],
    dedupe_key: "", status: "open", answer: null, external_ref: null, form: null, created_at: at, updated_at: at } as Card;
  const els = (renderCard(card).body as { elements: { tag: string; content?: string }[] }).elements;
  assert.deepEqual(els.filter((e) => e.tag === "markdown").map((e) => e.content), ["**残余风险**\n- a\n- b", "**结果**\n- 分支 `xj/T-1`", "**执行者说明**\n好了"]);
  const done = (renderAnswered({ ...card, status: "answered", answer: { choice: "accept" } }).body as { elements: { content: string }[] }).elements;
  assert.deepEqual(done.map((e) => e.content), ["**残余风险**\n- a\n- b", "**结果**\n- 分支 `xj/T-1`", "**执行者说明**\n好了", "**结论**：接受"]);
});
