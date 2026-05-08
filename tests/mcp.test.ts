import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleCompress,
  handleDecompress,
  handleRecompress,
  handleList,
  dispatch,
} from "../src/mcp/tools.ts";
import { sessionDir } from "../src/shared/paths.ts";
import { readBlock } from "../src/shared/registry.ts";

let tempRoot: string;
const TEST_SESSION = "test-mcp-session";

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

test("compress defaults token counts to 0 when omitted", async () => {
  await writeSimpleSessionJsonl(TEST_SESSION, ["msg_a"]);
  await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "s",
  });
  const block = await readBlock(TEST_SESSION, 1);
  assert.equal(block?.original_tokens, 0);
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

test("compress errors when session_id arg missing AND env var unset", async () => {
  const prev = process.env["CLAUDE_CODE_SESSION_ID"];
  delete process.env["CLAUDE_CODE_SESSION_ID"];
  try {
    const result = await handleCompress({
      compressed_uuids: ["msg_a"],
      summary: "s",
    });
    assert.equal(result.isError, true);
    assert.match(getText(result), /session_id/);
  } finally {
    if (prev !== undefined) process.env["CLAUDE_CODE_SESSION_ID"] = prev;
  }
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
  assert.equal(blocks[0]?.["compressed_uuid_count"], 1);
  assert.equal(blocks[0]?.["focus"], "f1");
  assert.equal(blocks[1]?.["block_id"], 2);
  assert.equal(blocks[1]?.["active"], true);
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
