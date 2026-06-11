import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleCompress,
  handlePlace,
  handleDecompress,
  handleRecompress,
  handleList,
  handleStartArc,
  handleCompressArc,
  dispatch,
} from "../src/mcp/tools.ts";
import { applySubstitutions } from "../src/proxy/transform.ts";
import { sessionDir } from "../src/shared/paths.ts";
import { readBlock } from "../src/shared/registry.ts";
import { getBookmark } from "../src/shared/bookmarks.ts";
import { projectSlugForDir } from "../src/proxy/jsonl.ts";
import {
  countTextTokens,
  CONTENT_CALIBRATION,
  SIGNATURE_CALIBRATION,
} from "../src/shared/token-count.ts";

let tempRoot: string;
const TEST_SESSION = "test-mcp-session";
const TEST_PROJECT_DIR = "/tmp/test-project";

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-mcp-test-"));
  process.env["CLAUDE_SHELVING_DIR"] = tempRoot;
  process.env["CLAUDE_PROJECTS_DIR"] = join(tempRoot, "projects");
  await mkdir(process.env["CLAUDE_PROJECTS_DIR"], { recursive: true });
});

after(async () => {
  delete process.env["CLAUDE_SHELVING_DIR"];
  delete process.env["CLAUDE_PROJECTS_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(sessionDir(TEST_SESSION), { recursive: true, force: true });
  await rm(join(process.env["CLAUDE_PROJECTS_DIR"]!, "-test-proj"), {
    recursive: true,
    force: true,
  });
  await rm(
    join(process.env["CLAUDE_PROJECTS_DIR"]!, projectSlugForDir(TEST_PROJECT_DIR)),
    {
      recursive: true,
      force: true,
    },
  );
  delete process.env["CLAUDE_PROJECT_DIR"];
  delete process.env["CLAUDE_CODE_SESSION_ID"];
});

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  const first = result.content[0];
  if (!first) throw new Error("no content in result");
  return JSON.parse(first.text);
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  const first = result.content[0];
  if (!first) throw new Error("no content in result");
  return first.text;
}

async function writeSimpleSessionJsonl(
  sessionId: string,
  uuids: string[],
): Promise<void> {
  const projDir = join(process.env["CLAUDE_PROJECTS_DIR"]!, "-test-proj");
  await mkdir(projDir, { recursive: true });
  const lines = uuids.map((uuid, idx) =>
    JSON.stringify({
      type: idx % 2 === 0 ? "user" : "assistant",
      uuid,
      message: {
        role: idx % 2 === 0 ? "user" : "assistant",
        content: `content-${uuid}`,
      },
      sessionId,
    }),
  );
  await writeFile(join(projDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

async function writeRawSessionJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const projDir = join(process.env["CLAUDE_PROJECTS_DIR"]!, "-test-proj");
  await mkdir(projDir, { recursive: true });
  await writeFile(
    join(projDir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

async function writeSessionJsonlForProjectDir(
  projectDir: string,
  sessionId: string,
  uuids: string[],
  mtimeMs: number,
): Promise<void> {
  const projDir = join(process.env["CLAUDE_PROJECTS_DIR"]!, projectSlugForDir(projectDir));
  await mkdir(projDir, { recursive: true });
  const path = join(projDir, `${sessionId}.jsonl`);
  const lines = uuids.map((uuid, idx) =>
    JSON.stringify({
      type: idx % 2 === 0 ? "user" : "assistant",
      uuid,
      message: {
        role: idx % 2 === 0 ? "user" : "assistant",
        content: `content-${uuid}`,
      },
      sessionId,
    }),
  );
  await writeFile(path, lines.join("\n") + "\n");
  const when = new Date(mtimeMs);
  await utimes(path, when, when);
}

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

test("compress creates a block with correct fields", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b", "msg_c"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", "msg_b", "msg_c"],
    summary: "Three messages collapsed.",
    focus: "test focus",
    original_tokens: 1500,
    summary_tokens: 50,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);
  assert.equal(payload["anchor_uuid"], "msg_a");
  assert.equal(payload["compressed_count"], 3);
  assert.equal(payload["original_tokens"], 1500);
  assert.equal(payload["summary_tokens"], 50);
  assert.equal(payload["active"], true);

  const block = await readBlock(TEST_SESSION, 1);
  assert.notEqual(block, null);
  assert.equal(block?.kind, "compression");
  assert.equal(block?.summary, "Three messages collapsed.");
  assert.equal(block?.focus, "test focus");
  assert.deepEqual(block?.compressed_uuids, ["msg_a", "msg_b", "msg_c"]);
  assert.equal(block?.parent_block_id, null);
  assert.equal(block?.active, true);
});

test("compress assigns monotonic block_ids", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b"]);
  const r1 = parseResult(
    await handleCompress({
      session_id: TEST_SESSION,
      compressed_uuids: ["msg_a"],
      summary: "first",
    }),
  ) as Record<string, unknown>;
  const r2 = parseResult(
    await handleCompress({
      session_id: TEST_SESSION,
      compressed_uuids: ["msg_b"],
      summary: "second",
    }),
  ) as Record<string, unknown>;

  assert.equal(r1["block_id"], 1);
  assert.equal(r2["block_id"], 2);
});

test("compress estimates original_tokens and defaults summary_tokens to 0 when omitted", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "s",
  });
  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(
    block?.original_tokens,
    Math.round(CONTENT_CALIBRATION * countTextTokens("content-msg_a")),
  );
  assert.equal(block?.summary_tokens, 0);
  assert.equal(block?.focus, null);
});

test("compress rejects empty compressed_uuids", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: [],
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /at least one element/);
});

test("compress rejects empty summary", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /summary/);
});

test("compress rejects whitespace-only summary", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "   \n  ",
  });
  assert.equal(result.isError, true);
});

test("compress rejects empty first_phrase", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b", "msg_c"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    first_phrase: "",
    preview_only: true,
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /first_phrase/);
});

test("compress rejects empty last_phrase", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b", "msg_c"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    first_phrase: "content-msg_a",
    last_phrase: "   ",
    preview_only: true,
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /last_phrase/);
});

test("compress preview includes turn numbers and short boundary snippets", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "start boundary message with enough text to make the preview obvious",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: "middle assistant message",
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: "ending boundary message for preview validation",
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    first_phrase: "start boundary",
    last_phrase: "ending boundary",
    preview_only: true,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["preview"], true);
  assert.equal(payload["start_turn"], 1);
  assert.equal(payload["end_turn"], 3);
  assert.match(String(payload["anchor_snippet"]), /start boundary message/);
  assert.match(String(payload["end_snippet"]), /ending boundary message/);
});

test("compress phrase preview auto-extends to include a paired tool_result", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "start boundary message",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "toolu_pair", name: "Bash", input: { cmd: "echo pair me" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_pair",
            content: "command output",
          },
        ],
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    first_phrase: "start boundary",
    last_phrase: "echo pair me",
    preview_only: true,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["preview"], true);
  assert.equal(payload["start_turn"], 1);
  assert.equal(payload["end_turn"], 3);
  assert.deepEqual(payload["range_uuids"], ["u1", "a1", "u2"]);
  assert.deepEqual(payload["extended_turns"], [3]);
  assert.match(String(payload["closure_note"]), /tool_result/i);
});

test("compress phrase-based compression keeps tool_use and tool_result together", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "start boundary message",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "toolu_pair", name: "Bash", input: { cmd: "echo pair me" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_pair",
            content: "command output",
          },
        ],
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    first_phrase: "start boundary",
    last_phrase: "echo pair me",
    confirm: true,
    summary: "paired tool exchange preserved",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["compressed_count"], 3);
  assert.equal(payload["anchor_uuid"], "u1");

  const block = await readBlock(TEST_SESSION, payload["block_id"] as number);
  assert.notEqual(block, null);
  assert.deepEqual(block?.compressed_uuids, ["u1", "a1", "u2"]);
});

test("compress turn preview returns preview payload and does not create a block", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2", "a2", "u3"]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    start_turn: 2,
    end_turn: 4,
    preview_only: true,
    summary: "placeholder summary",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["preview"], true);
  assert.equal(payload["start_turn"], 2);
  assert.equal(payload["end_turn"], 4);
  assert.match(String(payload["anchor_snippet"]), /content-a1/);
  assert.match(String(payload["end_snippet"]), /content-a2/);
  assert.deepEqual(payload["range_uuids"], ["a1", "u2", "a2"]);

  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(block, null);
});

test("compress turn preview extends backward when the selected start is a tool_result", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "before tool exchange",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_pair", name: "Bash", input: { cmd: "pwd" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_pair",
            content: "command output",
          },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: "after tool exchange",
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    start_turn: 3,
    end_turn: 4,
    preview_only: true,
    summary: "placeholder summary",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["start_turn"], 2);
  assert.equal(payload["end_turn"], 4);
  assert.deepEqual(payload["range_uuids"], ["a1", "u2", "a2"]);
  assert.deepEqual(payload["extended_turns"], [2]);
  assert.match(String(payload["closure_note"]), /tool_use/i);
});

test("compress UUID selection extends backward to include a paired tool_use", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_pair", name: "Bash", input: { cmd: "pwd" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_pair",
            content: "command output",
          },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: "after tool exchange",
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["u1", "a2"],
    summary: "paired tool exchange preserved",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["compressed_count"], 3);
  assert.equal(payload["anchor_uuid"], "a1");

  const block = await readBlock(TEST_SESSION, payload["block_id"] as number);
  assert.notEqual(block, null);
  assert.deepEqual(block?.compressed_uuids, ["a1", "u1", "a2"]);
});

test("compress estimation includes thinking, tool_use, and tool_result content", async () => {
  const toolInput = { file_path: "/tmp/example.txt" };
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "hello",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "brainstorm" },
          { type: "tool_use", name: "Read", input: toolInput },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["u1", "a1", "u2"],
    summary: "s",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  // Reconstruct the expectation independently of the estimator: per message,
  // tokenize the extracted text and apply the content calibration. The a1 block
  // contributes its thinking text + tool_use (name + JSON input); u2 its
  // tool_result text. None of these carry a signature. Spelling the content out
  // (rather than reusing the estimator's own extractor) makes this a real guard.
  const calcontent = (s: string) => Math.round(CONTENT_CALIBRATION * countTextTokens(s));
  const expected =
    calcontent("hello") +
    calcontent(["brainstorm", `Read\n${JSON.stringify(toolInput)}`].join("\n")) +
    calcontent("file contents");
  assert.equal(payload["original_tokens"], expected);
  // Guard the intent: the thinking + tool_use content must actually be counted,
  // so the estimate exceeds the prose-only blocks (u1 + u2 text) alone.
  const proseOnly = calcontent("hello") + calcontent("file contents");
  assert.ok(
    (payload["original_tokens"] as number) > proseOnly,
    "estimate should include thinking and tool_use content",
  );
});

test("compress estimation counts the calibrated fraction of thinking signatures", async () => {
  const signature = "S".repeat(2000); // stand-in for a base64 thinking signature
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature },
          { type: "text", text: "answer" },
        ],
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["a1"],
    summary: "s",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  // The signature is excluded from the visible content (messageContentToString)
  // but billed at SIGNATURE_CALIBRATION of its tokenized length. Reconstruct
  // both terms independently.
  const contentTokens = countTextTokens(["reasoning", "answer"].join("\n"));
  const signatureTokens = countTextTokens(signature);
  const expected = Math.round(
    CONTENT_CALIBRATION * contentTokens + SIGNATURE_CALIBRATION * signatureTokens,
  );
  assert.equal(payload["original_tokens"], expected);
  // The signature term must be doing real work: dropping it would under-count.
  assert.ok(
    expected > Math.round(CONTENT_CALIBRATION * contentTokens),
    "signature should contribute to the estimate",
  );
});

test("compress estimation includes image blocks nested inside tool_result content", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "rendered pdf pages" },
              {
                type: "image",
                width: 600,
                height: 900,
                source: { type: "base64", media_type: "image/png", data: "abc" },
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "def" },
              },
            ],
          },
        ],
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["u1"],
    summary: "s",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  const expected = Math.round(
    CONTENT_CALIBRATION * countTextTokens("rendered pdf pages") +
      600 * 900 / 750 +
      1500,
  );
  assert.equal(payload["original_tokens"], expected);
});

test("compress falls back to CLAUDE_CODE_SESSION_ID env var when session_id omitted", async () => {
  const prev = process.env["CLAUDE_CODE_SESSION_ID"];
  process.env["CLAUDE_CODE_SESSION_ID"] = TEST_SESSION;
  try {
    await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
    const result = await handleCompress({
      compressed_uuids: ["msg_a"],
      summary: "s",
    });
    assert.equal(result.isError, undefined);
    const payload = parseResult(result) as Record<string, unknown>;
    assert.equal(payload["block_id"], 1);
  } finally {
    if (prev === undefined) delete process.env["CLAUDE_CODE_SESSION_ID"];
    else process.env["CLAUDE_CODE_SESSION_ID"] = prev;
  }
});

test("compress falls back to the newest session transcript for CLAUDE_PROJECT_DIR", async () => {
  process.env["CLAUDE_PROJECT_DIR"] = TEST_PROJECT_DIR;
  const olderSession = "older-session";
  const newerSession = "newer-session";

  await writeSessionJsonlForProjectDir(TEST_PROJECT_DIR, olderSession, ["old_a"], 1_700_000_000_000);
  await writeSessionJsonlForProjectDir(
    TEST_PROJECT_DIR,
    newerSession,
    ["new_a"],
    1_700_000_000_100,
  );

  const result = await handleCompress({
    compressed_uuids: ["new_a"],
    summary: "s",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);

  const block = await readBlock(newerSession, 1);
  assert.notEqual(block, null);
  assert.equal(block?.anchor_uuid, "new_a");
});

test("compress errors when session_id arg missing AND env var unset", async () => {
  const result = await handleCompress({
    compressed_uuids: ["msg_a"],
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /session_id/);
});

test("compress rejects non-string uuids in array", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", 42 as unknown as string],
    summary: "s",
  });
  assert.equal(result.isError, true);
});

test("compress rejects UUIDs not found in the session JSONL", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b"]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", "missing", "msg_b"],
    summary: "s",
  });

  assert.equal(result.isError, true);
  assert.match(getText(result), /not found in session/);
});

test("compress rejects a non-contiguous range that skips an attachment UUID", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "fc09cd40-1c80-4423-a5e6-2748c2aec81c",
      message: {
        role: "user",
        content:
          "One other project that I hadn't had a chance to check out yet, but might be worth investigating: @~/claude-code-cmv/README.md",
      },
    },
    {
      type: "attachment",
      uuid: "30d30c4f-738b-4b6d-a30b-19971db732bd",
      attachment: {
        type: "file",
        filename: "/home/karel/claude-code-cmv/README.md",
        content: {
          type: "text",
          file: {
            filePath: "/home/karel/claude-code-cmv/README.md",
            content: "# Claude Code Contextual Memory Virtualisation (CMV)",
            startLine: 1,
          },
        },
      },
    },
    {
      type: "assistant",
      uuid: "e45e101d-ccd0-42af-bf01-dc2fc634d5ee",
      message: {
        role: "assistant",
        content: "Reading CMV against what we've been building is interesting.",
      },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: [
      "fc09cd40-1c80-4423-a5e6-2748c2aec81c",
      "e45e101d-ccd0-42af-bf01-dc2fc634d5ee",
    ],
    summary: "s",
  });

  assert.equal(result.isError, true);
  assert.match(getText(result), /contiguous range/);
  assert.match(getText(result), /30d30c4f-738b-4b6d-a30b-19971db732bd/);
});

test("compress accepts a contiguous range that includes an attachment UUID once", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "Prompt with @reference" },
    },
    {
      type: "attachment",
      uuid: "att1",
      attachment: {
        type: "file",
        filename: "/tmp/example.md",
        content: {
          type: "text",
          file: {
            filePath: "/tmp/example.md",
            content: "# Title\nBody",
            startLine: 1,
          },
        },
      },
    },
    {
      type: "assistant",
      uuid: "u2",
      message: { role: "assistant", content: "Response after reading file" },
    },
  ]);

  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["u1", "att1", "u2"],
    summary: "s",
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["compressed_count"], 3);
});

// ---------------------------------------------------------------------------
// place
// ---------------------------------------------------------------------------

test("place preview shows the anchor turn, current snippet, and replacement content", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2"]);

  const result = await handlePlace({
    session_id: TEST_SESSION,
    turn: 2,
    content: "A cool, dry river stone in the pocket.",
    preview_only: true,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["preview"], true);
  assert.equal(payload["anchor_turn"], 2);
  assert.equal(payload["anchor_uuid"], "a1");
  assert.match(String(payload["anchor_snippet"]), /content-a1/);
  assert.equal(
    payload["replacement_content"],
    "A cool, dry river stone in the pocket.",
  );

  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(block, null);
});

test("place creates a single-turn placement block from content_file and list_compressions surfaces kind", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2"]);
  const contentPath = join(tempRoot, "placement.txt");
  await writeFile(contentPath, "Wet granite smell after rain.\n", "utf-8");

  const result = await handlePlace({
    session_id: TEST_SESSION,
    anchor_uuid: "a1",
    content_file: contentPath,
    confirm: true,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);
  assert.equal(payload["anchor_uuid"], "a1");
  assert.equal(payload["compressed_count"], 1);
  assert.equal(payload["kind"], "placement");

  const block = await readBlock(TEST_SESSION, 1);
  assert.notEqual(block, null);
  assert.equal(block?.kind, "placement");
  assert.deepEqual(block?.compressed_uuids, ["a1"]);
  assert.equal(block?.summary, "Wet granite smell after rain.\n");

  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["u2"],
    summary: "compressed",
  });

  const listed = parseResult(
    await handleList({ session_id: TEST_SESSION }),
  ) as Record<string, unknown>;
  const blocks = listed["blocks"] as Array<Record<string, unknown>>;
  assert.equal(blocks[0]?.["kind"], "placement");
  assert.equal(blocks[1]?.["kind"], "compression");
});

test("place refuses to auto-extend a single-turn anchor that contains a tool_use with an external tool_result", async () => {
  await writeRawSessionJsonl(TEST_SESSION, [
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "toolu_pair", name: "Bash", input: { cmd: "pwd" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_pair",
            content: "command output",
          },
        ],
      },
    },
  ]);

  const result = await handlePlace({
    session_id: TEST_SESSION,
    turn: 1,
    content: "A cedar smell in the stairwell.",
    preview_only: true,
  });

  assert.equal(result.isError, true);
  assert.match(getText(result), /refuse|cannot/i);
  assert.match(getText(result), /tool_result/i);
});

test("decompress and recompress work for placement blocks", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1"]);
  await handlePlace({
    session_id: TEST_SESSION,
    phrase: "content-a1",
    content: "A brass key warmed by the sun.",
    confirm: true,
  });

  const blockBefore = await readBlock(TEST_SESSION, 1);
  assert.equal(blockBefore?.kind, "placement");
  assert.equal(blockBefore?.active, true);

  const decompressed = parseResult(
    await handleDecompress({ session_id: TEST_SESSION, block_id: 1 }),
  ) as Record<string, unknown>;
  assert.equal(decompressed["active"], false);
  assert.equal(decompressed["messages_restored"], 1);

  const blockAfterDecompress = await readBlock(TEST_SESSION, 1);
  assert.equal(blockAfterDecompress?.kind, "placement");
  assert.equal(blockAfterDecompress?.active, false);

  const recompressed = parseResult(
    await handleRecompress({ session_id: TEST_SESSION, block_id: 1 }),
  ) as Record<string, unknown>;
  assert.equal(recompressed["active"], true);
  assert.equal(recompressed["messages_replaced"], 1);

  const blockAfterRecompress = await readBlock(TEST_SESSION, 1);
  assert.equal(blockAfterRecompress?.kind, "placement");
  assert.equal(blockAfterRecompress?.active, true);
  assert.equal(blockAfterRecompress?.summary, blockBefore?.summary);
});

// ---------------------------------------------------------------------------
// decompress
// ---------------------------------------------------------------------------

test("decompress flips active to false", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b"]);
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", "msg_b"],
    summary: "s",
  });

  const result = await handleDecompress({
    session_id: TEST_SESSION,
    block_id: 1,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);
  assert.equal(payload["active"], false);
  assert.equal(payload["messages_restored"], 2);

  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(block?.active, false);
});

test("decompress on missing block returns error", async () => {
  const result = await handleDecompress({
    session_id: TEST_SESSION,
    block_id: 99,
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /not found/);
});

test("decompress rejects non-positive block_id", async () => {
  const result = await handleDecompress({
    session_id: TEST_SESSION,
    block_id: 0,
  });
  assert.equal(result.isError, true);
});

// ---------------------------------------------------------------------------
// recompress
// ---------------------------------------------------------------------------

test("recompress flips active back to true", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b"]);
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", "msg_b"],
    summary: "s",
  });
  await handleDecompress({ session_id: TEST_SESSION, block_id: 1 });

  const result = await handleRecompress({
    session_id: TEST_SESSION,
    block_id: 1,
  });

  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["active"], true);
  assert.equal(payload["messages_replaced"], 2);

  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(block?.active, true);
});

test("recompress preserves byte-identical summary", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const summary =
    "A specific multi-line summary\nwith embedded \"quotes\" and special chars: { } [ ]";
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary,
  });
  const before = await readBlock(TEST_SESSION, 1);

  await handleDecompress({ session_id: TEST_SESSION, block_id: 1 });
  await handleRecompress({ session_id: TEST_SESSION, block_id: 1 });

  const after = await readBlock(TEST_SESSION, 1);
  assert.equal(after?.summary, before?.summary);
  assert.deepEqual(after?.compressed_uuids, before?.compressed_uuids);
  assert.equal(after?.created_at, before?.created_at);
});

// ---------------------------------------------------------------------------
// list_compressions
// ---------------------------------------------------------------------------

test("list_compressions returns metadata for all blocks", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a", "msg_b", "msg_c"]);
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "first",
    focus: "f1",
  });
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_b", "msg_c"],
    summary: "second",
    focus: "f2",
  });
  await handleDecompress({ session_id: TEST_SESSION, block_id: 1 });

  const result = await handleList({ session_id: TEST_SESSION });
  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_count"], 2);
  assert.equal(payload["active_count"], 1);

  const blocks = payload["blocks"] as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.["block_id"], 1);
  assert.equal(blocks[0]?.["active"], false);
  assert.equal(blocks[0]?.["kind"], "compression");
  assert.equal(blocks[0]?.["compressed_uuid_count"], 1);
  assert.equal(blocks[0]?.["focus"], "f1");
  assert.equal(blocks[1]?.["block_id"], 2);
  assert.equal(blocks[1]?.["active"], true);
  assert.equal(blocks[1]?.["kind"], "compression");
  assert.equal(blocks[1]?.["compressed_uuid_count"], 2);
});

test("list_compressions returns empty for unknown session", async () => {
  const result = await handleList({ session_id: "no-such-session" });
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_count"], 0);
  assert.equal(payload["active_count"], 0);
  assert.deepEqual(payload["blocks"], []);
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test("dispatch routes to correct handler", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await dispatch("compress", {
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "s",
  });
  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);
});

test("dispatch routes place correctly", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  const result = await dispatch("place", {
    session_id: TEST_SESSION,
    anchor_uuid: "msg_a",
    content: "placed text",
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["block_id"], 1);
  assert.equal(payload["kind"], "placement");
});

test("dispatch returns error for unknown tool", async () => {
  const result = await dispatch("unknown_tool", {});
  assert.equal(result.isError, true);
  assert.match(getText(result), /Unknown tool/);
});

test("dispatch rejects non-object arguments", async () => {
  const result = await dispatch("compress", "not an object");
  assert.equal(result.isError, true);
  assert.match(getText(result), /must be an object/);
});

// ----------------------------------------------------------------------------
// start_arc / compress_arc
// ----------------------------------------------------------------------------

test("start_arc captures the most recent JSONL entry as anchor", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2", "a2", "u3"]);
  const result = await handleStartArc({
    session_id: TEST_SESSION,
    label: "chunk-1",
  });
  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["label"], "chunk-1");
  assert.equal(payload["anchor_uuid"], "u3");

  const stored = await getBookmark(TEST_SESSION, "chunk-1");
  assert.equal(stored?.anchor_uuid, "u3");
});

test("start_arc requires a non-empty label", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1"]);
  const result = await handleStartArc({
    session_id: TEST_SESSION,
    label: "",
  });
  assert.equal(result.isError, true);
});

test("start_arc errors when the session JSONL is missing", async () => {
  const result = await handleStartArc({
    session_id: "nonexistent-session",
    label: "chunk-1",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /not found/i);
});

test("compress_arc errors when the bookmark does not exist", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1"]);
  const result = await handleCompressArc({
    session_id: TEST_SESSION,
    label: "missing",
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /No bookmark/);
});

test("compress_arc captures the range from bookmark to last user message", async () => {
  // Initial state: one user message that the bookmark will anchor on.
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1"]);

  // Bookmark anchors at u1 (the only / latest entry).
  const startResult = await handleStartArc({
    session_id: TEST_SESSION,
    label: "chunk-1",
  });
  assert.equal(startResult.isError, undefined);

  // Simulate the assistant doing work: more messages arrive in the JSONL.
  // u1, a1, u2 (tool_result), a2 (tool_use), u3 (tool_result).
  // We rewrite the file to extend the sequence.
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2", "a2", "u3"]);

  const result = await handleCompressArc({
    session_id: TEST_SESSION,
    label: "chunk-1",
    summary: "what happened in chunk 1",
    focus: "test arc",
  });
  assert.equal(result.isError, undefined);
  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["label"], "chunk-1");
  assert.equal(payload["anchor_uuid"], "u1");
  // Range is u1..u3 inclusive → 5 UUIDs.
  assert.equal(payload["compressed_count"], 5);
  assert.ok((payload["original_tokens"] as number) > 0);

  // Verify the block landed in the registry with the right shape.
  const block = await readBlock(TEST_SESSION, payload["block_id"] as number);
  assert.notEqual(block, null);
  assert.deepEqual(block?.compressed_uuids, ["u1", "a1", "u2", "a2", "u3"]);
  assert.equal(block?.summary, "what happened in chunk 1");
  assert.equal(block?.focus, "test arc");
  assert.ok((block?.original_tokens ?? 0) > 0);

  // The bookmark should be consumed after a successful compress_arc.
  const consumed = await getBookmark(TEST_SESSION, "chunk-1");
  assert.equal(consumed, null);
});

test("compress_arc closes a bookmark range that starts on a tool_result anchor", async () => {
  const toolUse = {
    type: "tool_use",
    id: "toolu_arc",
    name: "Bash",
    input: { cmd: "pwd" },
  };
  const toolResult = {
    type: "tool_result",
    tool_use_id: "toolu_arc",
    content: [{ type: "text", text: "/tmp/project" }],
    is_error: false,
  };
  const jsonlLines = [
    {
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: "start work",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [toolUse],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [toolResult],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: "tool handled",
      },
    },
    {
      type: "user",
      uuid: "u3",
      message: {
        role: "user",
        content: "next task",
      },
    },
  ];
  await writeRawSessionJsonl(TEST_SESSION, jsonlLines);

  const { setBookmark } = await import("../src/shared/bookmarks.ts");
  await setBookmark(TEST_SESSION, {
    label: "tool-anchor",
    anchor_uuid: "u2",
    created_at: new Date().toISOString(),
  });

  const result = await handleCompressArc({
    session_id: TEST_SESSION,
    label: "tool-anchor",
    summary: "closed tool arc",
  });
  assert.equal(result.isError, undefined);

  const payload = parseResult(result) as Record<string, unknown>;
  assert.equal(payload["anchor_uuid"], "a1");
  assert.equal(payload["compressed_count"], 4);

  const block = await readBlock(TEST_SESSION, payload["block_id"] as number);
  assert.notEqual(block, null);
  assert.deepEqual(block?.compressed_uuids, ["a1", "u2", "a2", "u3"]);

  const jsonlMessages = jsonlLines.map((line) => ({
    uuid: line.uuid,
    role: line.message.role,
    content: line.message.content,
  }));
  const request = {
    messages: jsonlMessages.map(({ role, content }) => ({ role, content })),
  };
  const transformed = applySubstitutions(request, jsonlMessages, [block!]);
  assert.equal(transformed.anchors_substituted, 1);
  assert.equal(transformed.messages_dropped, 3);
  assert.equal(transformed.request.messages.length, 2);

  const transformedJson = JSON.stringify(transformed.request.messages);
  assert.match(transformedJson, /closed tool arc/);
  assert.doesNotMatch(transformedJson, /toolu_arc/);
  assert.doesNotMatch(transformedJson, /tool_result/);
});

test("compress_arc errors if no user message exists at or after the bookmark", async () => {
  // Anchor at an assistant message, and have no subsequent user messages.
  // (Pathological case — start_arc usually points at user messages, but this
  // verifies the explicit error rather than a silent empty-range block.)
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1"]);
  // Manually inject a bookmark anchored at the assistant message.
  const { setBookmark } = await import("../src/shared/bookmarks.ts");
  await setBookmark(TEST_SESSION, {
    label: "bad-anchor",
    anchor_uuid: "a1",
    created_at: new Date().toISOString(),
  });
  // No new user messages appear; the only user message u1 is BEFORE a1.
  const result = await handleCompressArc({
    session_id: TEST_SESSION,
    label: "bad-anchor",
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /no user message/i);
});

test("compress_arc errors when the bookmark anchor UUID is not in the JSONL", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2"]);
  const { setBookmark } = await import("../src/shared/bookmarks.ts");
  await setBookmark(TEST_SESSION, {
    label: "ghost",
    anchor_uuid: "missing-uuid",
    created_at: new Date().toISOString(),
  });
  const result = await handleCompressArc({
    session_id: TEST_SESSION,
    label: "ghost",
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /not found/i);
});

test("dispatch routes start_arc and compress_arc correctly", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1"]);
  const startResult = await dispatch("start_arc", {
    session_id: TEST_SESSION,
    label: "via-dispatch",
  });
  assert.equal(startResult.isError, undefined);
  await writeSimpleSessionJsonl(TEST_SESSION, ["u1", "a1", "u2"]);
  const compressResult = await dispatch("compress_arc", {
    session_id: TEST_SESSION,
    label: "via-dispatch",
    summary: "dispatched summary",
  });
  assert.equal(compressResult.isError, undefined);
  const payload = parseResult(compressResult) as Record<string, unknown>;
  assert.equal(payload["label"], "via-dispatch");
});
