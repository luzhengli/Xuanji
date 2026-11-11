// 把内核的卡片渲染成飞书 Card 2.0。卡片正文有长度上限，细节放证据链接。
import type { Card } from "../../kernel/types.ts";

const TEMPLATE = { decision: "orange", review: "blue", notice: "grey" } as const;

export function renderCard(card: Card): Record<string, unknown> {
  const elements: unknown[] = [{ tag: "markdown", content: card.body || "（无正文）" }];
  if (card.kind !== "notice") {
    for (const o of card.options) {
      elements.push({ tag: "button", text: { tag: "plain_text", content: o.recommended ? `${o.label}（推荐）` : o.label },
        type: o.recommended ? "primary" : "default", behaviors: [{ type: "callback", value: { card_id: card.id, choice: o.key } }] });
    }
    // TODO P1-11：选项都不合适时的文字框（form + input），以及适用范围选择（仅这件事 / 这个项目 / 以后都这样）。
  }
  return {
    schema: "2.0", config: { update_multi: true, width_mode: "default" },
    header: { title: { tag: "plain_text", content: card.title }, subtitle: { tag: "plain_text", content: `${card.id} · ${card.about}` }, template: TEMPLATE[card.kind] },
    body: { elements },
  };
}

// 回答后卡片原地改成结论，不能再点。
export function renderAnswered(card: Card, choice: string): Record<string, unknown> {
  return {
    schema: "2.0", config: { update_multi: true, width_mode: "default" },
    header: { title: { tag: "plain_text", content: card.title }, subtitle: { tag: "plain_text", content: `${card.id} · 已回答：${choice}` }, template: "green" },
    body: { elements: [{ tag: "markdown", content: card.body || "" }] },
  };
}
