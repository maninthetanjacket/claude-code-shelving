import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSessionJsonl, parseSessionJsonl } from "../src/proxy/jsonl.ts";
import { countContentTokens } from "../src/shared/token-count.ts";
import {
  buildTurns,
  groupTurns,
  buildScaffold,
  readTimestamps,
  SCAFFOLD_PLACEHOLDER,
} from "../src/cli/session-map.ts";

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-session-map-test-"));
  process.env["CLAUDE_PROJECTS_DIR"] = tempRoot;
});

after(async () => {
  delete process.env["CLAUDE_PROJECTS_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

interface Entry {
  uuid: string;
  role: "user" | "assistant";
  content: string | unknown[];
  ts: string;
}

function line(e: Entry): object {
  return {
    type: e.role,
    uuid: e.uuid,
    timestamp: e.ts,
    message: { role: e.role, content: e.content },
  };
}

async function writeSession(sessionId: string, entries: object[]): Promise<string> {
  const dir = join(tempRoot, "-proj");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, entries.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function collapseConsecutiveDuplicates(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (out[out.length - 1] !== v) out.push(v);
  return out;
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

test("turn numbers are positions in the collapsed UUID stream (incl. duplicates)", async () => {
  const sid = "sess-align";
  // a1 appears as two consecutive lines with the same uuid -> one collapsed turn.
  const path = await writeSession(sid, [
    line({ uuid: "u1", role: "user", content: "hello", ts: at(0) }),
    line({ uuid: "a1", role: "assistant", content: "world part 1", ts: at(1) }),
    line({ uuid: "a1", role: "assistant", content: "world part 2", ts: at(1) }),
    line({ uuid: "u2", role: "user", content: "again", ts: at(2) }),
    line({ uuid: "a2", role: "assistant", content: "reply", ts: at(3) }),
  ]);

  const messages = await parseSessionJsonl(path);
  const timestamps = await readTimestamps(path);
  const turns = buildTurns(messages, timestamps);

  const expected = collapseConsecutiveDuplicates(messages.map((m) => m.uuid));
  assert.deepEqual(turns.map((t) => t.uuid), expected);
  assert.deepEqual(turns.map((t) => t.turn), [1, 2, 3, 4]);
  // The duplicate-uuid turn carries both source messages.
  assert.equal(turns[1]!.messages.length, 2);
});

test("groups split on gaps larger than the threshold, merge below it", async () => {
  const sid = "sess-gap";
  const path = await writeSession(sid, [
    line({ uuid: "u1", role: "user", content: "a", ts: at(0) }),
    line({ uuid: "a1", role: "assistant", content: "b", ts: at(2) }),
    line({ uuid: "u2", role: "user", content: "c", ts: at(5) }),
    // 60-minute gap here -> new group at turn 4
    line({ uuid: "u3", role: "user", content: "d", ts: at(65) }),
    line({ uuid: "a3", role: "assistant", content: "e", ts: at(66) }),
  ]);

  const messages = await parseSessionJsonl(path);
  const turns = buildTurns(messages, await readTimestamps(path));
  const groups = groupTurns(turns, 30);

  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0]!.start_turn, groups[0]!.end_turn], [1, 3]);
  assert.deepEqual([groups[1]!.start_turn, groups[1]!.end_turn], [4, 5]);
  assert.equal(groups[0]!.turn_count, 3);
  assert.equal(groups[1]!.turn_count, 2);

  // A larger threshold keeps everything in one group.
  assert.equal(groupTurns(turns, 120).length, 1);
});

test("group token sums match summed countContentTokens and the session total", async () => {
  const sid = "sess-tokens";
  const path = await writeSession(sid, [
    line({ uuid: "u1", role: "user", content: "the quick brown fox", ts: at(0) }),
    line({ uuid: "a1", role: "assistant", content: "jumps over the lazy dog", ts: at(1) }),
    line({ uuid: "u2", role: "user", content: "and runs away fast", ts: at(90) }),
  ]);

  const messages = await parseSessionJsonl(path);
  const turns = buildTurns(messages, await readTimestamps(path));
  const groups = groupTurns(turns, 30);

  const fromMessages = messages.reduce((s, m) => s + countContentTokens(m.content), 0);
  const fromGroups = groups.reduce((s, g) => s + g.tokens, 0);
  assert.equal(fromGroups, fromMessages);
  assert.ok(fromGroups > 0);
});

test("emit-block produces an inert scaffold aligned to the group range", async () => {
  const sid = "sess-scaffold";
  const path = await writeSession(sid, [
    line({ uuid: "u1", role: "user", content: "start the work", ts: at(0) }),
    line({ uuid: "a1", role: "assistant", content: "ok doing it", ts: at(1) }),
    line({ uuid: "u2", role: "user", content: "more", ts: at(2) }),
  ]);

  const messages = await parseSessionJsonl(path);
  const turns = buildTurns(messages, await readTimestamps(path));
  const groups = groupTurns(turns, 30);
  const block = buildScaffold(groups[0]!, turns);

  assert.equal(block.active, false);
  assert.equal(block.kind, "compression");
  assert.equal(block.summary_tokens, 0);
  assert.equal(block.block_id, 0);
  assert.equal(block.parent_block_id, null);
  assert.equal(block.anchor_uuid, block.compressed_uuids[0]);
  assert.equal(block.anchor_uuid, "u1");
  assert.equal(block.compressed_uuids.length, groups[0]!.turn_count);
  assert.deepEqual(block.compressed_uuids, ["u1", "a1", "u2"]);
  assert.equal(block.original_tokens, groups[0]!.tokens);
  assert.ok(block.summary.includes(SCAFFOLD_PLACEHOLDER));
});

test("findSessionJsonl + readTimestamps round-trip recovers per-uuid timestamps", async () => {
  const sid = "sess-ts";
  await writeSession(sid, [
    line({ uuid: "u1", role: "user", content: "x", ts: at(0) }),
    line({ uuid: "a1", role: "assistant", content: "y", ts: at(7) }),
  ]);
  const path = await findSessionJsonl(sid);
  assert.ok(path !== null);
  const ts = await readTimestamps(path!);
  assert.equal(ts.get("u1"), at(0));
  assert.equal(ts.get("a1"), at(7));
});
