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
