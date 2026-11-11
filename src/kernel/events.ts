// 事件日志：只追加、可去重。
import type { DB } from "./store.ts";
import type { Event, EventInput } from "./types.ts";

export function appendEvent(db: DB, input: EventInput): Event | null {
  const r = db.prepare(
    `INSERT INTO events(source, source_id, type, at, about, hops, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id) DO NOTHING`,
  ).run(input.source, input.source_id, input.type, input.at, input.about ?? null, input.hops ?? 0, JSON.stringify(input.payload));
  if (r.changes === 0) return null; // 重复事件
  return { ...input, seq: Number(r.lastInsertRowid) };
}

export function readEvents(db: DB, fromSeq = 0): Event[] {
  return (db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(fromSeq) as Record<string, unknown>[]).map(rowToEvent);
}

// 一个编号的全部事件：事件自己标的 about，加上归并时回写到关联表里的（含签发该编号的那条）。
export function eventsAbout(db: DB, ref: string): Event[] {
  return (db.prepare("SELECT * FROM events WHERE about = ? OR seq IN (SELECT seq FROM event_refs WHERE ref = ?) ORDER BY seq")
    .all(ref, ref) as Record<string, unknown>[]).map(rowToEvent);
}

function rowToEvent(r: Record<string, unknown>): Event {
  return {
    seq: r.seq as number, source: r.source as Event["source"], source_id: r.source_id as string, type: r.type as string,
    at: r.at as string, about: (r.about as string | null) ?? undefined, hops: r.hops as number,
    payload: JSON.parse(r.payload as string),
  };
}
