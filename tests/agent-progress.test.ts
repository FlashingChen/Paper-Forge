import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentProgressReporter, progressLabel } from "../src/lib/agent-progress";
import { publicLogs } from "../src/lib/security/public-job";

test("activity tags survive snapshot sanitization without exposing arbitrary model text", () => {
  const logs = ["[progress:crop page=2 question=8]", "private model text", "[progress:crop page=0]", "[progress:crop page=2 secret=key]"].map(text => ({ts:1, level:"info" as const, text}));
  const safe = publicLogs(logs);
  assert.deepEqual(safe.map(x => x.text), ["正在裁切原图中的题目插图（第 2 张图片 · 第 8 题）"]);
  assert.deepEqual(publicLogs(safe), safe);
  assert.equal(progressLabel("[progress:check]"), "正在核对文字、插图与版面");
});

test("streaming split tags appear before message end and are not reported twice", () => {
  const reporter = new AgentProgressReporter(), tags: string[] = [];
  const emit = (tag: string) => tags.push(tag);
  reporter.consume({type:"message_start"}, emit);
  for (const delta of ["[pro", "gress:recognize page=1", " question=3] extra text"]) {
    reporter.consume({type:"message_update", assistantMessageEvent:{type:"text_delta", delta}}, emit);
  }
  assert.deepEqual(tags, ["[progress:recognize page=1 question=3]"]);
  reporter.consume({type:"message_end", message:{role:"assistant", content:[{type:"text", text:"[progress:recognize page=1 question=3]"}]}}, emit);
  assert.equal(tags.length, 1);
  reporter.consume({type:"message_start"}, emit);
  reporter.consume({type:"message_end", message:{role:"assistant", content:"[progress:recognize page=1 question=3]"}}, emit);
  assert.equal(tags.length, 2);
});
