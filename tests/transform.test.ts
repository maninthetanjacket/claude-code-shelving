import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applySubstitutions,
  type ApiMessage,
  type ApiRequest,
  type JsonlMessage,
} from "../src/proxy/transform.ts";
import type { Block } from "../src/shared/types.ts";

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    block_id: 1,
    created_at: "2026-05-08T14:30:00Z",
    active: true,
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Test summary",
    original_tokens: 1000,
    summary_tokens: 100,
    focus: null,
    parent_block_id: null,
    ...overrides,
  };
}

function makeJsonl(entries: Array<[string, "user" | "assistant", string]>): JsonlMessage[] {
  return entries.map(([uuid, role, content]) => ({ uuid, role, content }));
}

function makeRequest(messages: ApiMessage[], extras: Record<string, unknown> = {}): ApiRequest {
  return { messages, ...extras };
}

test("no active blocks: request passes through unchanged", () => {
  const request = makeRequest([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  const result = applySubstitutions(request, [], []);
  assert.deepEqual(result.request, request);
  assert.equal(result.anchors_substituted, 0);
  assert.equal(result.messages_dropped, 0);
});

test("simple substitution: contiguous range collapses to summary at anchor", () => {
  const request = makeRequest([
    { role: "user", content: "first" },
    { role: "user", content: "msg1" },
    { role: "assistant", content: "msg2" },
    { role: "user", content: "msg3" },
    { role: "user", content: "last" },
  ]);

  const jsonl = makeJsonl([
    ["u_first", "user", "first"],
    ["u1", "user", "msg1"],
    ["u2", "assistant", "msg2"],
    ["u3", "user", "msg3"],
    ["u_last", "user", "last"],
  ]);

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Three messages collapsed.",
  });

  const result = applySubstitutions(request, jsonl, [block]);

  assert.equal(result.request.messages.length, 3);
  assert.equal(result.request.messages[0]?.content, "first");
  assert.match(
    result.request.messages[1]?.content as string,
    /Three messages collapsed\./,
  );
  assert.match(
    result.request.messages[1]?.content as string,
    /\[shelved: block 1, 3 messages\]/,
  );
  assert.equal(result.request.messages[2]?.content, "last");

  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("anchor preserves the original message's role", () => {
  const request = makeRequest([
    { role: "assistant", content: "anchor msg" },
    { role: "user", content: "drop msg" },
  ]);
  const jsonl = makeJsonl([
    ["u1", "assistant", "anchor msg"],
    ["u2", "user", "drop msg"],
  ]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "summary",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages[0]?.role, "assistant");
});

test("focus appears in shelved marker", () => {
  const request = makeRequest([{ role: "user", content: "msg1" }]);
  const jsonl = makeJsonl([["u1", "user", "msg1"]]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1"],
    summary: "summary",
    focus: "preserved decisions about auth",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.match(
    result.request.messages[0]?.content as string,
    /preserved decisions about auth/,
  );
});

test("inactive blocks (passed in but active=false) are still processed if caller filtered correctly", () => {
  // Note: applySubstitutions trusts the caller to pass only active blocks.
  // This test documents that contract.
  const request = makeRequest([{ role: "user", content: "msg1" }]);
  const jsonl = makeJsonl([["u1", "user", "msg1"]]);
  const block = makeBlock({
    active: false,
    anchor_uuid: "u1",
    compressed_uuids: ["u1"],
  });

  // If caller passes an inactive block, we still apply it. Caller's job to filter.
  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.anchors_substituted, 1);
});

test("message in request not in JSONL: passes through", () => {
  const request = makeRequest([
    { role: "user", content: "in-jsonl" },
    { role: "system" as "user", content: "injected at runtime" },
    { role: "user", content: "also-in-jsonl" },
  ]);
  const jsonl = makeJsonl([
    ["u1", "user", "in-jsonl"],
    ["u2", "user", "also-in-jsonl"],
  ]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "s",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  // The injected message should pass through; u1 and u2 substitute as one anchor.
  // Order in result: [anchor-summary, injected, drop?]
  // Actually: walk request: [u1→anchor, injected→passthrough, u2→drop]
  assert.equal(result.request.messages.length, 2);
  assert.match(result.request.messages[0]?.content as string, /\[shelved/);
  assert.equal(result.request.messages[1]?.content, "injected at runtime");
});

test("UUID in block but not in JSONL: that message can't be matched, passes through", () => {
  const request = makeRequest([
    { role: "user", content: "msg1" },
    { role: "user", content: "msg2" },
  ]);
  // jsonl missing u2
  const jsonl = makeJsonl([["u1", "user", "msg1"]]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
  });

  const result = applySubstitutions(request, jsonl, [block]);
  // u1 substitutes (anchor); u2 not in jsonl so msg2 passes through
  assert.equal(result.request.messages.length, 2);
  assert.match(result.request.messages[0]?.content as string, /Test summary/);
  assert.equal(result.request.messages[1]?.content, "msg2");
});

test("array-form content is matched by JSON serialization", () => {
  const arrayContent = [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
  ];
  const request = makeRequest([{ role: "assistant", content: arrayContent }]);
  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "assistant", content: arrayContent },
  ];
  const block = makeBlock({ anchor_uuid: "u1", compressed_uuids: ["u1"] });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.anchors_substituted, 1);
  assert.equal(typeof result.request.messages[0]?.content, "string");
});

test("multiple non-overlapping blocks: each applied independently", () => {
  const request = makeRequest([
    { role: "user", content: "a1" },
    { role: "user", content: "a2" },
    { role: "user", content: "middle" },
    { role: "user", content: "b1" },
    { role: "user", content: "b2" },
  ]);
  const jsonl = makeJsonl([
    ["ua1", "user", "a1"],
    ["ua2", "user", "a2"],
    ["um", "user", "middle"],
    ["ub1", "user", "b1"],
    ["ub2", "user", "b2"],
  ]);
  const blockA = makeBlock({
    block_id: 1,
    anchor_uuid: "ua1",
    compressed_uuids: ["ua1", "ua2"],
    summary: "A summary",
  });
  const blockB = makeBlock({
    block_id: 2,
    anchor_uuid: "ub1",
    compressed_uuids: ["ub1", "ub2"],
    summary: "B summary",
  });

  const result = applySubstitutions(request, jsonl, [blockA, blockB]);
  assert.equal(result.request.messages.length, 3);
  assert.match(result.request.messages[0]?.content as string, /A summary/);
  assert.equal(result.request.messages[1]?.content, "middle");
  assert.match(result.request.messages[2]?.content as string, /B summary/);
  assert.deepEqual(result.blocks_applied, [1, 2]);
  assert.equal(result.anchors_substituted, 2);
  assert.equal(result.messages_dropped, 2);
});

test("block whose UUIDs aren't in the request is reported as inactive_in_request", () => {
  const request = makeRequest([{ role: "user", content: "current" }]);
  const jsonl = makeJsonl([
    ["u_old", "user", "old message"],
    ["u_current", "user", "current"],
  ]);
  const block = makeBlock({
    block_id: 1,
    anchor_uuid: "u_old",
    compressed_uuids: ["u_old"],
  });

  const result = applySubstitutions(request, jsonl, [block]);
  // u_old not in request, block has no effect
  assert.equal(result.request.messages.length, 1);
  assert.equal(result.request.messages[0]?.content, "current");
  assert.deepEqual(result.blocks_applied, []);
  assert.deepEqual(result.blocks_inactive_in_request, [1]);
});

test("non-message fields (model, system, tools) pass through unchanged", () => {
  const request = makeRequest(
    [{ role: "user", content: "msg1" }],
    {
      model: "claude-opus-4.7",
      system: "You are helpful.",
      tools: [{ name: "Bash" }],
      max_tokens: 1000,
    },
  );
  const jsonl = makeJsonl([["u1", "user", "msg1"]]);
  const block = makeBlock({ anchor_uuid: "u1", compressed_uuids: ["u1"] });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request["model"], "claude-opus-4.7");
  assert.equal(result.request["system"], "You are helpful.");
  assert.deepEqual(result.request["tools"], [{ name: "Bash" }]);
  assert.equal(result.request["max_tokens"], 1000);
});

test("determinism: same inputs produce byte-identical output", () => {
  const request = makeRequest([
    { role: "user", content: "msg1" },
    { role: "user", content: "msg2" },
    { role: "user", content: "msg3" },
  ]);
  const jsonl = makeJsonl([
    ["u1", "user", "msg1"],
    ["u2", "user", "msg2"],
    ["u3", "user", "msg3"],
  ]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
  });

  const r1 = applySubstitutions(request, jsonl, [block]);
  const r2 = applySubstitutions(request, jsonl, [block]);
  assert.equal(JSON.stringify(r1.request), JSON.stringify(r2.request));
});
