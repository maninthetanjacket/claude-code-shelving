import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readBlock,
  writeBlock,
  listBlocks,
  listActiveBlocks,
  nextBlockId,
  setBlockActive,
  sessionMtime,
} from "../src/shared/registry.ts";
import { sessionDir } from "../src/shared/paths.ts";
import type { Block } from "../src/shared/types.ts";

let tempRoot: string;
const TEST_SESSION = "test-session-abcdef";

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-test-"));
  process.env["CLAUDE_SHELVING_DIR"] = tempRoot;
});

after(async () => {
  delete process.env["CLAUDE_SHELVING_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean session directory between tests
  const dir = sessionDir(TEST_SESSION);
  await rm(dir, { recursive: true, force: true });
});

function makeBlock(id: number, overrides: Partial<Block> = {}): Block {
  return {
    block_id: id,
    created_at: "2026-05-08T14:30:00Z",
    active: true,
    anchor_uuid: `msg_anchor_${id}`,
    compressed_uuids: [`msg_anchor_${id}`, `msg_${id}_b`, `msg_${id}_c`],
    summary: `Summary for block ${id}`,
    original_tokens: 10000,
    summary_tokens: 500,
    focus: "test focus",
    parent_block_id: null,
    ...overrides,
  };
}

test("empty session returns empty list and null mtime", async () => {
  assert.deepEqual(await listBlocks(TEST_SESSION), []);
  assert.deepEqual(await listActiveBlocks(TEST_SESSION), []);
  assert.equal(await sessionMtime(TEST_SESSION), null);
  assert.equal(await readBlock(TEST_SESSION, 1), null);
  assert.equal(await nextBlockId(TEST_SESSION), 1);
});

test("write then read round-trips correctly", async () => {
  const original = makeBlock(1);
  await writeBlock(TEST_SESSION, original);

  const restored = await readBlock(TEST_SESSION, 1);
  assert.deepEqual(restored, original);
});

test("write creates session directory if missing", async () => {
  const block = makeBlock(1);
  await writeBlock(TEST_SESSION, block);

  const entries = await readdir(sessionDir(TEST_SESSION));
  assert.deepEqual(entries.sort(), ["1.json"]);
});

test("write is atomic: no .tmp file remains after success", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1));
  await writeBlock(TEST_SESSION, makeBlock(2));

  const entries = await readdir(sessionDir(TEST_SESSION));
  assert.deepEqual(
    entries.sort(),
    ["1.json", "2.json"],
    "no .tmp files should be left behind",
  );
});

test("listBlocks returns blocks sorted by block_id ascending", async () => {
  await writeBlock(TEST_SESSION, makeBlock(3));
  await writeBlock(TEST_SESSION, makeBlock(1));
  await writeBlock(TEST_SESSION, makeBlock(2));

  const blocks = await listBlocks(TEST_SESSION);
  assert.deepEqual(
    blocks.map((b) => b.block_id),
    [1, 2, 3],
  );
});

test("listActiveBlocks filters by active flag", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1, { active: true }));
  await writeBlock(TEST_SESSION, makeBlock(2, { active: false }));
  await writeBlock(TEST_SESSION, makeBlock(3, { active: true }));

  const active = await listActiveBlocks(TEST_SESSION);
  assert.deepEqual(
    active.map((b) => b.block_id),
    [1, 3],
  );
});

test("nextBlockId is max + 1, including inactive blocks", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1));
  assert.equal(await nextBlockId(TEST_SESSION), 2);

  await writeBlock(TEST_SESSION, makeBlock(2, { active: false }));
  assert.equal(await nextBlockId(TEST_SESSION), 3);

  await writeBlock(TEST_SESSION, makeBlock(7));
  assert.equal(await nextBlockId(TEST_SESSION), 8);
});

test("setBlockActive flips active flag and persists", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1, { active: true }));

  const result = await setBlockActive(TEST_SESSION, 1, false);
  assert.notEqual(result, null);
  assert.equal(result?.active, false);

  const reread = await readBlock(TEST_SESSION, 1);
  assert.equal(reread?.active, false);
});

test("setBlockActive returns null for missing block", async () => {
  const result = await setBlockActive(TEST_SESSION, 99, false);
  assert.equal(result, null);
});

test("setBlockActive is no-op when state already matches", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1, { active: true }));
  const before = await sessionMtime(TEST_SESSION);

  // Small delay so any actual write would change mtime
  await new Promise((r) => setTimeout(r, 10));

  const result = await setBlockActive(TEST_SESSION, 1, true);
  assert.equal(result?.active, true);

  const after = await sessionMtime(TEST_SESSION);
  assert.equal(before, after, "mtime should be unchanged for no-op");
});

test("sessionMtime returns a number after first write, increases after second", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1));
  const t1 = await sessionMtime(TEST_SESSION);
  assert.equal(typeof t1, "number");

  await new Promise((r) => setTimeout(r, 10));
  await writeBlock(TEST_SESSION, makeBlock(2));
  const t2 = await sessionMtime(TEST_SESSION);
  assert.equal(typeof t2, "number");
  assert.ok(t2! >= t1!, "mtime should not decrease after a write");
});

test("listBlocks ignores .tmp files and non-numeric filenames", async () => {
  await writeBlock(TEST_SESSION, makeBlock(1));

  // Manually drop a .tmp file and a stray file in the directory
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(sessionDir(TEST_SESSION), "999.json.tmp"), "{}");
  await fs.writeFile(join(sessionDir(TEST_SESSION), "notes.txt"), "hello");

  const blocks = await listBlocks(TEST_SESSION);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.block_id, 1);
});
