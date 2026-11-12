// 把内核的卡片渲染成飞书 Card 2.0。卡片正文有长度上限，细节放证据链接。
// 决策卡和审核卡整张是一个表单：文字框、适用范围（仅决策卡）和选项按钮都在里面，点任一按钮就把文字框和范围一起交上来。
// 表单内的按钮不能带回调值，所以按钮名里编进卡片编号和选项序号：xj_C_3_o0、xj_C_3_text。
import type { Card, RulingScope } from "../../kernel/types.ts";

const TEMPLATE = { decision: "orange", review: "blue", notice: "grey" } as const;

export const SCOPES: { value: RulingScope; label: string }[] = [
  { value: "task", label: "仅这件事" },
  { value: "goal", label: "这个目标" },
  { value: "project", label: "这个项目" },
  { value: "global", label: "以后都这样" },
];

const nameOf = (cardId: string, which: string) => `xj_${cardId.replace("-", "_")}_${which}`;

// 从按钮名解出卡片编号和点的是哪个：选项序号，或“用文字回答”。认不出返回 null。
export function parseButtonName(name: string): { card_id: string; option_index?: number } | null {
  const m = /^xj_C_(\d+)_(?:o(\d+)|text)$/.exec(name);
  if (!m) return null;
  return m[2] === undefined ? { card_id: `C-${m[1]}` } : { card_id: `C-${m[1]}`, option_index: Number(m[2]) };
}

// 文字框的提示语：目标卡写修改意见，超预算卡写给下一轮的话，决策卡是选项之外的回答，审核卡是退回或接管的意见。
const PLACEHOLDER = (card: Card): string =>
  card.form === "goal" ? "要改什么写在这里，再点“修改”"
    : card.form === "budget" ? "追加时想交代下一轮的话（可选）"
      : card.form === "verify" ? "选“再给 3 轮”时想交代下一轮的话（可选）"
      : card.kind === "decision" ? "选项都不合适时写一句话（可选）" : "退回或接管时写意见（可选）";

export function renderCard(card: Card): Record<string, unknown> {
  const elements: unknown[] = [{ tag: "markdown", content: card.body || "（无正文）" }];
  if (card.kind !== "notice") {
    // 目标卡和超预算卡的回答就是按钮本身，不落成定论，所以没有适用范围，也没有“用这句话回答”。
    const plainDecision = card.kind === "decision" && !card.form;
    const form: unknown[] = [{ tag: "input", name: "text", max_length: 500, placeholder: { tag: "plain_text", content: PLACEHOLDER(card) } }];
    if (plainDecision) {
      form.push({ tag: "select_static", name: "scope", initial_option: "task",
        placeholder: { tag: "plain_text", content: "适用范围" },
        options: SCOPES.map((s) => ({ text: { tag: "plain_text", content: s.label }, value: s.value })) });
    }
    card.options.forEach((o, i) => form.push({
      tag: "button", name: nameOf(card.id, `o${i}`), form_action_type: "submit",
      text: { tag: "plain_text", content: o.recommended ? `${o.label}（推荐）` : o.label }, type: o.recommended ? "primary" : "default",
    }));
    if (plainDecision) {
      form.push({ tag: "button", name: nameOf(card.id, "text"), form_action_type: "submit",
        text: { tag: "plain_text", content: "用上面这句话回答" }, type: "default" });
    }
    elements.push({ tag: "form", name: "answer", elements: form });
  }
  return {
    schema: "2.0", config: { update_multi: true, width_mode: "default" },
    header: { title: { tag: "plain_text", content: card.title }, subtitle: { tag: "plain_text", content: `${card.id} · ${card.about}` }, template: TEMPLATE[card.kind] },
    body: { elements },
  };
}

const STATUS_TEXT: Record<Card["status"], string> = { open: "待处理", answered: "已回答", expired: "已过期", withdrawn: "已撤回", folded: "已收起" };

// 回答后卡片原地改成账本里记下的结论，不能再点。撤回、收起的卡片被点到时，也按账本里的状态改掉。
export function renderAnswered(card: Card): Record<string, unknown> {
  const a = card.answer ?? {};
  const label = card.options.find((o) => o.key === a.choice)?.label ?? a.choice ?? "";
  const verdict = [label && `**结论**：${label}`, a.text && `**说明**：${a.text}`,
    a.scope && a.scope !== "task" && `**适用范围**：${SCOPES.find((s) => s.value === a.scope)?.label ?? a.scope}`].filter(Boolean).join("\n");
  return {
    schema: "2.0", config: { update_multi: true, width_mode: "default" },
    header: { title: { tag: "plain_text", content: card.title }, subtitle: { tag: "plain_text", content: `${card.id} · ${STATUS_TEXT[card.status]}` },
      template: card.status === "answered" ? "green" : "grey" },
    body: { elements: [{ tag: "markdown", content: [card.body, verdict || (card.status === "withdrawn" ? "**已撤回**：情况变了（例如你补充了一句、问题已经不用答），不用再处理"
      : card.status === "folded" ? "**已收起**：已汇总进简报，不用再处理" : "")].filter(Boolean).join("\n\n") || "（已回答）" }] },
  };
}
