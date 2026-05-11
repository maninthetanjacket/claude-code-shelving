import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getBookmark,
  setBookmark,
  deleteBookmark,
  listBookmarks,
  readBookmarks,
} from "../src/shared/bookmarks.ts";
import type { Bookmark } from "../src/shared/types.ts";

let tempRoot: string;
const TEST_SESSION = "test-bookmark-session";

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-bookmark-test-"));
  process.env["CLAUDE_SHELVING_DIR"] = tempRoot;
});

after(async () => {
  delete process.env["CLAUDE_SHELVING_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe the session directory between tests for isolation.
  await rm(join(tempRoot, TEST_SESSION), { recursive: true, force: true });
});

function makeBookmark(label: string, anchor: string): Bookmark {
  return {
    label,
    anchor_uuid: anchor,
    created_at: new Date().toISOString(),
  };
}

test("readBookmarks on a fresh session returns an empty map", async () => {
  const file = await readBookmarks(TEST_SESSION);
  assert.equal(file.version, 1);
  assert.deepEqual(file.bookmarks, {});
});

test("setBookmark + getBookmark round-trips", async () => {
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-1"));
  const got = await getBookmark(TEST_SESSION, "chunk-1");
  assert.notEqual(got, null);
  assert.equal(got?.label, "chunk-1");
  assert.equal(got?.anchor_uuid, "uuid-1");
});

test("getBookmark returns null for missing label", async () => {
  const got = await getBookmark(TEST_SESSION, "nonexistent");
  assert.equal(got, null);
});

test("setBookmark with existing label overwrites", async () => {
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-1"));
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-2"));
  const got = await getBookmark(TEST_SESSION, "chunk-1");
  assert.equal(got?.anchor_uuid, "uuid-2");
});

test("multiple bookmarks coexist in one session", async () => {
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-1"));
  await setBookmark(TEST_SESSION, makeBookmark("chunk-2", "uuid-2"));
  await setBookmark(TEST_SESSION, makeBookmark("chunk-3", "uuid-3"));
  const all = await listBookmarks(TEST_SESSION);
  assert.equal(all.length, 3);
  const labels = all.map((b) => b.label).sort();
  assert.deepEqual(labels, ["chunk-1", "chunk-2", "chunk-3"]);
});

test("deleteBookmark returns true when removing, false when missing", async () => {
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-1"));
  const removed = await deleteBookmark(TEST_SESSION, "chunk-1");
  assert.equal(removed, true);
  const got = await getBookmark(TEST_SESSION, "chunk-1");
  assert.equal(got, null);
  const removedAgain = await deleteBookmark(TEST_SESSION, "chunk-1");
  assert.equal(removedAgain, false);
});

test("deleteBookmark on missing label is a no-op", async () => {
  const removed = await deleteBookmark(TEST_SESSION, "nonexistent");
  assert.equal(removed, false);
});

test("listBookmarks sorts by created_at ascending", async () => {
  const now = Date.now();
  // Construct explicit timestamps so sort order is unambiguous.
  await setBookmark(TEST_SESSION, {
    label: "second",
    anchor_uuid: "u2",
    created_at: new Date(now + 1000).toISOString(),
  });
  await setBookmark(TEST_SESSION, {
    label: "first",
    anchor_uuid: "u1",
    created_at: new Date(now).toISOString(),
  });
  await setBookmark(TEST_SESSION, {
    label: "third",
    anchor_uuid: "u3",
    created_at: new Date(now + 2000).toISOString(),
  });
  const ordered = await listBookmarks(TEST_SESSION);
  assert.deepEqual(
    ordered.map((b) => b.label),
    ["first", "second", "third"],
  );
});

test("malformed bookmarks file is treated as empty", async () => {
  // Write a manual malformed file.
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(tempRoot, TEST_SESSION), { recursive: true });
  await writeFile(
    join(tempRoot, TEST_SESSION, "bookmarks.json"),
    JSON.stringify({ version: 999, bookmarks: { foo: "bar" } }),
    "utf-8",
  );
  const file = await readBookmarks(TEST_SESSION);
  assert.equal(file.version, 1);
  assert.deepEqual(file.bookmarks, {});
});

test("writes are atomic (no .tmp file remains after success)", async () => {
  await setBookmark(TEST_SESSION, makeBookmark("chunk-1", "uuid-1"));
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(join(tempRoot, TEST_SESSION));
  const tmps = entries.filter((e) => e.endsWith(".tmp"));
  assert.equal(tmps.length, 0);
});
