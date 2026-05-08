import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
});

after(async () => {
  delete process.env["CLAUDE_SHELVING_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(sessionDir(TEST_SESSION), { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

test("compress creates a block with correct fields", async () => {
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
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: [],
    summary: "s",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /at least one element/);
});

test("compress rejects empty summary", async () => {
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a"],
    summary: "",
  });
  assert.equal(result.isError, true);
  assert.match(getText(result), /summary/);
});

test("compress rejects whitespace-only summary", async () => {
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
  const result = await handleCompress({
    session_id: TEST_SESSION,
    compressed_uuids: ["msg_a", 42 as unknown as string],
    summary: "s",
  });
  assert.equal(result.isError, true);
});

// ---------------------------------------------------------------------------
// decompress
// ---------------------------------------------------------------------------

test("decompress flips active to false", async () => {
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
