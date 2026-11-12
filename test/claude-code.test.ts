import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStream } from "../src/worker/adapters/claude-code.ts";

test("从录制的 stream-json 里取回执、会话编号和周用量（实测 S2/S3）", () => {
  const r = parseStream(readFileSync(new URL("./fixtures/claude-stream-resume.ndjson", import.meta.url), "utf8"));
  assert.equal(r.last_message, "jade-ring");
  assert.equal(r.session_id, "bdbd97c1-075d-4666-834a-bed06a991baa");
  assert.equal(r.rate_limit?.seven_day?.utilization, 0.44);
  assert.equal(r.rate_limit?.seven_day?.resetsAt, 1794524400);
  assert.equal(r.rate_limited, false);
});

test("P2-00 实测：周用量过 75% 时 rate_limit_event 的 status 是 allowed_warning，还能用，不算限流；rejected 才算", async () => {
  const { parseStream } = await import("../src/worker/adapters/claude-code.ts");
  const line = (status: string) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status, unifiedWindows: {
    five_hour: { utilization: 0.72, resetsAt: 1794507600, status: "allowed" },
    seven_day: { utilization: 0.78, resetsAt: 1794524400, status: "allowed_warning", surpassedThreshold: 0.75 } } } });
  const result = JSON.stringify({ type: "result", result: "{}", session_id: "s" });
  const warn = parseStream(`${line("allowed_warning")}\n${result}`);
  assert.equal(warn.rate_limited, false);
  assert.equal(warn.rate_limit?.seven_day?.utilization, 0.78);
  assert.equal(parseStream(`${line("rejected")}\n${result}`).rate_limited, true);
});
