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
    kind: "compression",
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

/** Assert no two adjacent messages share a role (the post-merge invariant). */
function assertAlternates(messages: ApiMessage[]): void {
  for (let i = 1; i < messages.length; i++) {
    assert.notEqual(
      messages[i]?.role,
      messages[i - 1]?.role,
      `messages ${i - 1} and ${i} share role ${String(messages[i]?.role)}`,
    );
  }
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

  // Substitution mechanics: anchor replaced, two messages dropped.
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);

  // The surviving same-role neighbours (all "user" here) fold into the summary
  // message, leaving a well-formed sequence with the content preserved.
  assertAlternates(result.request.messages);
  const text = JSON.stringify(result.request.messages);
  assert.match(text, /first/);
  assert.match(text, /Three messages collapsed\./);
  assert.match(text, /\[shelved: block 1, 3 messages\]/);
  assert.match(text, /last/);
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

test("placement blocks substitute through the proxy with the same mechanics as compression blocks", () => {
  const request = makeRequest([{ role: "user", content: "msg1" }]);
  const jsonl = makeJsonl([["u1", "user", "msg1"]]);
  const block = makeBlock({
    kind: "placement",
    anchor_uuid: "u1",
    compressed_uuids: ["u1"],
    summary: "Placed sensory stone.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 0);
  assert.match(result.request.messages[0]?.content as string, /Placed sensory stone\./);
  assert.match(result.request.messages[0]?.content as string, /\[shelved: block 1, 1 messages\]/);
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
  // u1 substitutes (anchor); u2 not in jsonl so msg2 passes through. Both are
  // user-role, so the merge folds them into one well-formed message that keeps
  // the summary and the passed-through content.
  assert.equal(result.anchors_substituted, 1);
  assertAlternates(result.request.messages);
  const text = JSON.stringify(result.request.messages);
  assert.match(text, /Test summary/);
  assert.match(text, /msg2/);
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

test("attachment-derived Read reminder and result can be substituted by shared uuid", () => {
  const reminder =
    '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/tmp/example.md"}\n</system-reminder>';
  const resultBlock = [
    {
      type: "text",
      text:
        "<system-reminder>\n" +
        "Result of calling the Read tool:\n" +
        "1\t# Title\n" +
        "2\tBody\n" +
        "</system-reminder>",
    },
  ];

  const request = makeRequest([
    { role: "user", content: "Prompt with @reference" },
    { role: "user", content: reminder },
    { role: "user", content: resultBlock },
    { role: "assistant", content: "Response after reading file" },
  ]);
  const jsonl = makeJsonl([
    ["u1", "user", "Prompt with @reference"],
    ["att1", "user", reminder],
    ["att1", "user", resultBlock],
    ["u2", "assistant", "Response after reading file"],
  ]);
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "att1", "u2"],
    summary: "Collapsed @reference exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.match(
    result.request.messages[0]?.content as string,
    /Collapsed @reference exchange\./,
  );
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 3);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("combined attachment result plus prompt and assistant thinking still match the compressed block", () => {
  const readResult =
    "<system-reminder>\n" +
    "Result of calling the Read tool:\n" +
    "1\t# Title\n" +
    "2\tBody\n" +
    "</system-reminder>";

  const request = makeRequest([
    {
      role: "user",
      content:
        '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/tmp/example.md"}\n</system-reminder>',
    },
    {
      role: "user",
      content: [
        { type: "text", text: readResult + "\n" },
        { type: "text", text: "Prompt with @reference" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", signature: "sig" },
        { type: "text", text: "Response after reading file" },
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "user", content: "Prompt with @reference" },
    {
      uuid: "att1",
      role: "user",
      content:
        '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/tmp/example.md"}\n</system-reminder>',
    },
    {
      uuid: "att1",
      role: "user",
      content: [{ type: "text", text: readResult }],
    },
    {
      uuid: "u2",
      role: "assistant",
      content: [{ type: "text", text: "Response after reading file" }],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "att1", "u2"],
    summary: "Collapsed @reference exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.ok(Array.isArray(result.request.messages[0]?.content));
  const content = result.request.messages[0]?.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.["type"], "text");
  assert.match(String(content[0]?.["text"]), /Collapsed @reference exchange\./);
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("tool_result with trailing injected system reminder still matches its JSONL uuid", () => {
  const request = makeRequest([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me write the corrected block:" },
        {
          type: "tool_use",
          id: "toolu_fix",
          name: "Bash",
          input: { command: "cat > /tmp/block-1-fix.json ..." },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_fix",
          type: "tool_result",
          content:
            "{\n  \"block_id\": 1,\n  \"active\": true\n}\n\n" +
            "<system-reminder>\n" +
            "Note: /tmp/block-1-fix.json was modified, either by the user or by a linter.\n" +
            "</system-reminder>",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Registry now has the corrected UUIDs." }],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        { type: "text", text: "Let me write the corrected block:" },
        {
          type: "tool_use",
          id: "toolu_fix",
          name: "Bash",
          input: { command: "cat > /tmp/block-1-fix.json ..." },
        },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      content: [
        {
          tool_use_id: "toolu_fix",
          type: "tool_result",
          content: "{\n  \"block_id\": 1,\n  \"active\": true\n}",
          is_error: false,
        },
      ],
    },
    {
      uuid: "u3",
      role: "assistant",
      content: [{ type: "text", text: "Registry now has the corrected UUIDs." }],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Collapsed block-fix exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.match(
    result.request.messages[0]?.content as string,
    /Collapsed block-fix exchange\./,
  );
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("tool_result still matches when request drops trailing control chars before an injected reminder", () => {
  const request = makeRequest([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_pdf",
          name: "Read",
          input: { file_path: "/tmp/chunk.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pdf",
          type: "tool_result",
          content:
            "1\tLine one\n2\tLine two\n3\t24\n\n" +
            "<system-reminder>\n" +
            "The task tools haven't been used recently.\n\n" +
            "</system-reminder>",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Chunk 2 shelved." }],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_pdf",
          name: "Read",
          input: { file_path: "/tmp/chunk.txt" },
        },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pdf",
          type: "tool_result",
          content: "1\tLine one\n2\tLine two\n3\t24\t\f",
          is_error: false,
        },
      ],
    },
    {
      uuid: "u3",
      role: "assistant",
      content: [{ type: "text", text: "Chunk 2 shelved." }],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Collapsed PDF read exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.match(
    result.request.messages[0]?.content as string,
    /Collapsed PDF read exchange\./,
  );
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("tool_use still matches when JSONL includes caller metadata but request omits it", () => {
  const request = makeRequest([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_fix",
          name: "Bash",
          input: { command: "ls src/shared/" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_fix",
          type: "tool_result",
          content: "paths.ts\nregistry.ts\ntypes.ts",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Now I know what's in src/shared." }],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_fix",
          name: "Bash",
          input: { command: "ls src/shared/" },
          caller: { type: "direct" },
        },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      content: [
        {
          tool_use_id: "toolu_fix",
          type: "tool_result",
          content: "paths.ts\nregistry.ts\ntypes.ts",
          is_error: false,
        },
      ],
    },
    {
      uuid: "u3",
      role: "assistant",
      content: [{ type: "text", text: "Now I know what's in src/shared." }],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Collapsed tool-use exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.match(
    result.request.messages[0]?.content as string,
    /Collapsed tool-use exchange\./,
  );
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("tool_use_id pairing pulls both sides of a tool exchange into the same block", () => {
  const request = makeRequest([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_pair",
          name: "Read",
          input: { file_path: "/tmp/live-output.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pair",
          type: "tool_result",
          content:
            "live output with drift\n\n" +
            "<system-reminder>\n" +
            "A harness reminder was appended here.\n" +
            "</system-reminder>",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I read the live file." }],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_pair",
          name: "Read",
          input: { file_path: "/tmp/jsonl-output.txt" },
          caller: { type: "direct" },
        },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pair",
          type: "tool_result",
          content: "jsonl output from disk",
          is_error: false,
        },
      ],
    },
    {
      uuid: "u3",
      role: "assistant",
      content: [{ type: "text", text: "I read the live file." }],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Collapsed paired tool exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.ok(Array.isArray(result.request.messages[0]?.content));
  const content = result.request.messages[0]?.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.["type"], "text");
  assert.match(String(content[0]?.["text"]), /Collapsed paired tool exchange\./);
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 2);
  assert.deepEqual(result.blocks_applied, [1]);
});

test("embedded tool_use anchor inside a larger assistant message is rewritten in place", () => {
  const request = makeRequest([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", signature: "sig" },
        { type: "text", text: "Section structure mapped." },
        {
          type: "tool_use",
          id: "toolu_pdf",
          name: "Bash",
          input: { command: "pdftotext file.pdf -f 1 -l 12 -" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pdf",
          type: "tool_result",
          content: "PDF content",
          is_error: false,
        },
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_pdf",
          name: "Bash",
          input: { command: "pdftotext file.pdf -f 1 -l 12 -" },
          caller: { type: "direct" },
        },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      content: [
        {
          tool_use_id: "toolu_pdf",
          type: "tool_result",
          content: "PDF content",
          is_error: false,
        },
      ],
    },
  ];
  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "Collapsed PDF read exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.equal(result.request.messages.length, 1);
  assert.equal(result.request.messages[0]?.role, "assistant");
  assert.ok(Array.isArray(result.request.messages[0]?.content));
  const content = result.request.messages[0]?.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 3);
  assert.equal(content[0]?.["type"], "thinking");
  assert.equal(content[1]?.["type"], "text");
  assert.equal(content[1]?.["text"], "Section structure mapped.");
  assert.equal(content[2]?.["type"], "text");
  assert.match(String(content[2]?.["text"]), /Collapsed PDF read exchange\./);
  assert.equal(result.anchors_substituted, 1);
  assert.equal(result.messages_dropped, 1);
  assert.deepEqual(result.blocks_applied, [1]);
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

  // Both blocks apply independently: two anchors substituted, two dropped.
  assert.deepEqual(result.blocks_applied, [1, 2]);
  assert.equal(result.anchors_substituted, 2);
  assert.equal(result.messages_dropped, 2);

  // All survivors are user-role here, so they fold into a single well-formed
  // message carrying both summaries and the middle passthrough.
  assertAlternates(result.request.messages);
  const text = JSON.stringify(result.request.messages);
  assert.match(text, /A summary/);
  assert.match(text, /middle/);
  assert.match(text, /B summary/);
});

test("block does not partially apply when only non-anchor tool_result is present", () => {
  const toolResult = [
    {
      tool_use_id: "toolu_123",
      type: "tool_result",
      content: "tool output",
      is_error: false,
    },
  ];
  const request = makeRequest([{ role: "user", content: toolResult }]);
  const jsonl: JsonlMessage[] = [
    {
      uuid: "u_tool",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_123", name: "Bash", input: { cmd: "ls" } },
      ],
    },
    { uuid: "u_result", role: "user", content: toolResult },
  ];
  const block = makeBlock({
    anchor_uuid: "u_tool",
    compressed_uuids: ["u_tool", "u_result"],
    summary: "collapsed tool exchange",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  assert.deepEqual(result.request.messages, request.messages);
  assert.equal(result.anchors_substituted, 0);
  assert.equal(result.messages_dropped, 0);
  assert.deepEqual(result.blocks_applied, []);
  assert.deepEqual(result.blocks_inactive_in_request, [1]);
});

test("mixed user message keeps a live tool_result when only trailing text is compressed", () => {
  const request = makeRequest([
    { role: "user", content: "anchor" },
    { role: "assistant", content: "drop me" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "live-tool", name: "Bash", input: { cmd: "pwd" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "rejected",
          is_error: true,
        },
        { type: "text", text: "compressed follow-up" },
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "user", content: "anchor" },
    { uuid: "u2", role: "assistant", content: "drop me" },
    {
      uuid: "u_live_use",
      role: "assistant",
      content: [
        { type: "tool_use", id: "live-tool", name: "Bash", input: { cmd: "pwd" } },
      ],
    },
    {
      uuid: "u_live_result",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "rejected",
          is_error: true,
        },
      ],
    },
    {
      uuid: "u3",
      role: "user",
      content: [{ type: "text", text: "compressed follow-up" }],
    },
  ];

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3"],
    summary: "Collapsed opening.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed opening\./);
  assert.deepEqual(msgs[1]?.content, [
    { type: "tool_use", id: "live-tool", name: "Bash", input: { cmd: "pwd" } },
  ]);
  assert.deepEqual(msgs[2]?.content, [
    {
      type: "tool_result",
      tool_use_id: "live-tool",
      content: "rejected",
      is_error: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(msgs[2]?.content), /compressed follow-up/);
});

test("mixed user message drops merged image fragments that belong to shelved turns", () => {
  const imageA = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "aaa" },
  };
  const imageB = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "bbb" },
  };

  const request = makeRequest([
    { role: "user", content: "anchor" },
    { role: "assistant", content: "drop me" },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "live output",
          is_error: false,
        },
        imageA,
        imageB,
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "user", content: "anchor" },
    { uuid: "u2", role: "assistant", content: "drop me" },
    {
      uuid: "u_live_result",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "live output",
          is_error: false,
        },
      ],
    },
    { uuid: "u3", role: "user", content: [imageA] },
    { uuid: "u4", role: "user", content: [imageB] },
  ];

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3", "u4"],
    summary: "Collapsed opening.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.deepEqual(msgs.map((m) => m.role), ["user"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed opening\./);
  assert.match(JSON.stringify(msgs[0]?.content), /live output/);
  assert.doesNotMatch(JSON.stringify(msgs[0]?.content), /"image"/);
});

test("legacy block that only captured a Read tool pair still drops child image turns", () => {
  const imageA = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "aaa" },
  };
  const imageB = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "bbb" },
  };

  const request = makeRequest([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_pdf", name: "Read", input: { file_path: "/tmp/book.pdf" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_pdf",
          content: "PDF pages extracted: 2 page(s)",
          is_error: false,
        },
      ],
    },
    {
      role: "user",
      content: [imageA, imageB],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    {
      uuid: "u1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_pdf", name: "Read", input: { file_path: "/tmp/book.pdf" } },
      ],
    },
    {
      uuid: "u2",
      role: "user",
      parent_uuid: "u1",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_pdf",
          content: "PDF pages extracted: 2 page(s)",
          is_error: false,
        },
      ],
    },
    {
      uuid: "u3",
      role: "user",
      parent_uuid: "u2",
      content: [imageA, imageB],
    },
  ];

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "Collapsed PDF read exchange.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.deepEqual(msgs.map((m) => m.role), ["assistant"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed PDF read exchange\./);
  assert.doesNotMatch(JSON.stringify(msgs[0]?.content), /"image"/);
});

test("mixed user message drops merged document fragments that belong to shelved turns", () => {
  const documentA = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "doc-a" },
  };
  const documentB = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "doc-b" },
  };

  const request = makeRequest([
    { role: "user", content: "anchor" },
    { role: "assistant", content: "drop me" },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "live output",
          is_error: false,
        },
        documentA,
        documentB,
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "user", content: "anchor" },
    { uuid: "u2", role: "assistant", content: "drop me" },
    {
      uuid: "u_live_result",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: "live output",
          is_error: false,
        },
      ],
    },
    { uuid: "u3", role: "user", content: [documentA] },
    { uuid: "u4", role: "user", content: [documentB] },
  ];

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3", "u4"],
    summary: "Collapsed opening.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.deepEqual(msgs.map((m) => m.role), ["user"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed opening\./);
  assert.match(JSON.stringify(msgs[0]?.content), /live output/);
  assert.doesNotMatch(JSON.stringify(msgs[0]?.content), /"document"/);
});

test("mixed tool_result content drops nested document and search_result fragments that belong to shelved turns", () => {
  const documentBlock = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "nested-doc" },
  };
  const searchResultBlock = {
    type: "search_result",
    title: "Proxy note",
    url: "https://example.test/proxy-note",
    snippets: ["one", "two"],
  };

  const request = makeRequest([
    { role: "user", content: "anchor" },
    { role: "assistant", content: "drop me" },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: [
            { type: "text", text: "live output" },
            documentBlock,
            searchResultBlock,
          ],
          is_error: false,
        },
      ],
    },
  ]);

  const jsonl: JsonlMessage[] = [
    { uuid: "u1", role: "user", content: "anchor" },
    { uuid: "u2", role: "assistant", content: "drop me" },
    {
      uuid: "u_live_result",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "live-tool",
          content: [{ type: "text", text: "live output" }],
          is_error: false,
        },
      ],
    },
    { uuid: "u3", role: "user", content: [documentBlock] },
    { uuid: "u4", role: "user", content: [searchResultBlock] },
  ];

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3", "u4"],
    summary: "Collapsed opening.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.deepEqual(msgs.map((m) => m.role), ["user"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed opening\./);
  assert.match(JSON.stringify(msgs[0]?.content), /live output/);
  assert.doesNotMatch(JSON.stringify(msgs[0]?.content), /"document"/);
  assert.doesNotMatch(JSON.stringify(msgs[0]?.content), /search_result/);
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

// CC interleaves `role:"system"` reminders that have no JSONL UUID, so the
// matcher passes them through. Dropping the assistant turns they preceded used
// to strand them (API: "role 'system' must precede an 'assistant' message or
// end the array") and could leave the user anchor adjacent to a following user
// turn. normalizeMessageSequence must repair both.
const sys = (content: string): ApiMessage =>
  ({ role: "system", content } as unknown as ApiMessage);

test("orphaned system reminders are pruned and same-role turns merged", () => {
  const request = makeRequest([
    { role: "user", content: "opening" }, // anchor
    sys("reminder A"), // preceded the now-dropped turn2
    { role: "assistant", content: "turn2" }, // drop
    { role: "user", content: "turn3" }, // drop
    sys("reminder B"), // preceded the now-dropped turn4
    { role: "assistant", content: "turn4" }, // drop
    { role: "user", content: "yep looks great" }, // survives (post-range)
    { role: "assistant", content: "reply" }, // survives
    { role: "user", content: "tool follow-up" }, // survives
  ]);

  const jsonl = makeJsonl([
    ["u1", "user", "opening"],
    ["u2", "assistant", "turn2"],
    ["u3", "user", "turn3"],
    ["u4", "assistant", "turn4"],
    ["u5", "user", "yep looks great"],
    ["u6", "assistant", "reply"],
    ["u7", "user", "tool follow-up"],
  ]);

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2", "u3", "u4"],
    summary: "Collapsed opening arc.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  // No system reminder survived (both were orphaned by the dropped assistants).
  assert.equal(
    msgs.filter((m) => (m.role as string) === "system").length,
    0,
  );
  // No two consecutive messages share a role.
  for (let i = 1; i < msgs.length; i++) {
    assert.notEqual(
      msgs[i]?.role,
      msgs[i - 1]?.role,
      `messages ${i - 1} and ${i} share role ${msgs[i]?.role}`,
    );
  }
  // The anchor (user) merged with the following user turn: summary + "yep".
  assert.equal(msgs[0]?.role, "user");
  const firstText = JSON.stringify(msgs[0]?.content);
  assert.match(firstText, /Collapsed opening arc\./);
  assert.match(firstText, /yep looks great/);
  // Sequence is user → assistant → user.
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
});

test("a system reminder that still precedes an assistant is preserved", () => {
  const request = makeRequest([
    { role: "user", content: "opening" }, // anchor
    { role: "assistant", content: "drop me" }, // drop
    sys("live reminder"), // still precedes a surviving assistant
    { role: "assistant", content: "real reply" }, // survives
    { role: "user", content: "follow up" }, // survives
  ]);

  const jsonl = makeJsonl([
    ["u1", "user", "opening"],
    ["u2", "assistant", "drop me"],
    ["u3", "assistant", "real reply"],
    ["u4", "user", "follow up"],
  ]);

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "Collapsed.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  // The live reminder is retained, still immediately before an assistant turn.
  const sysIdx = msgs.findIndex((m) => (m.role as string) === "system");
  assert.notEqual(sysIdx, -1, "live reminder should be preserved");
  assert.equal(msgs[sysIdx + 1]?.role, "assistant");
  assert.equal(msgs[sysIdx]?.content, "live reminder");
});

test("a system reminder after an assistant summary is pruned unless that assistant ends in server_tool_result", () => {
  const request = makeRequest([
    { role: "assistant", content: "anchor" }, // anchor
    { role: "user", content: "drop me" }, // drop
    sys("task reminder"), // invalid after assistant summary
    { role: "assistant", content: "real reply" }, // survives
  ]);

  const jsonl = makeJsonl([
    ["u1", "assistant", "anchor"],
    ["u2", "user", "drop me"],
    ["u3", "assistant", "real reply"],
  ]);

  const block = makeBlock({
    anchor_uuid: "u1",
    compressed_uuids: ["u1", "u2"],
    summary: "Collapsed.",
  });

  const result = applySubstitutions(request, jsonl, [block]);
  const msgs = result.request.messages;

  assert.equal(
    msgs.some((m) => (m.role as string) === "system"),
    false,
    "system reminder should be dropped after assistant summary text",
  );
  assert.deepEqual(msgs.map((m) => m.role), ["assistant"]);
  assert.match(JSON.stringify(msgs[0]?.content), /Collapsed\./);
  assert.match(JSON.stringify(msgs[0]?.content), /real reply/);
});
