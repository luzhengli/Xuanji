// 任务状态机。四类互斥且覆盖全部情况：等人、等 Agent、等世界、不再等。
import type { TaskState } from "./types.ts";

export type WaitingOn = "human" | "agent" | "world" | "none";

const GROUP: Record<TaskState, WaitingOn> = {
  awaiting_answer: "human", awaiting_review: "human", blocked: "human",
  queued: "agent", running: "agent", verifying: "agent",
  awaiting_world: "world", awaiting_deps: "world",
  done: "none", abandoned: "none", stopped: "none",
};

export function waitingOn(state: TaskState): WaitingOn { return GROUP[state]; }
export function isTerminal(state: TaskState): boolean { return GROUP[state] === "none"; }
export function occupiesSlot(state: TaskState): boolean { return GROUP[state] === "agent"; }

// 允许的迁移。不在表里的迁移一律拒绝，这样投影出错会在写入时暴露，而不是在重放时。
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued:          ["running", "awaiting_deps", "stopped", "abandoned"],
  running:         ["verifying", "awaiting_answer", "awaiting_world", "blocked", "queued", "stopped", "done"],
  verifying:       ["awaiting_review", "queued", "done", "stopped"],
  awaiting_answer: ["queued", "stopped", "abandoned"],
  awaiting_review: ["done", "queued", "stopped"],
  blocked:         ["queued", "abandoned", "stopped"],
  awaiting_world:  ["queued", "stopped", "abandoned"],
  awaiting_deps:   ["queued", "stopped", "abandoned"],
  done: [], abandoned: [], stopped: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(taskId: string, from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new Error(`${taskId}: 不允许的状态迁移 ${from} -> ${to}`);
}
