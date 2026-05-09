/**
 * Tests for the find-arc CLI.
 *
 * We test by spawning the built CLI as a subprocess against synthetic
 * JSONL fixtures, then parsing JSON output. This validates end-to-end
 * behavior — argument parsing, file resolution, search, clustering,
 * formatting — the way a user would invoke it.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = join(process.cwd(), "dist/cli/find-arc.js");

interface Candidate {
  first_uuid: string;
  last_uuid: string;
  uuids: string[];
  turn_count: number;
  estimated_tokens: number;
  first_preview: string;
  last_preview: string;
  match_count: number;
  match_kind: "phrase" | "all-words" | "any-word";
}

interface Output {
  query: string;
  total_messages: number;
  candidates: Candidate[];
}

let projectsDir: string;
let sessionId: string;

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
}

function userTurn(n: number, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uuid(n),
    message: { role: "user", content: text },
  });
}

function assistantTurn(n: number, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(n),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

function toolUseTurn(n: number, toolName: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(n),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
    },
  });
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECTS_DIR: projectsDir },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runJson(args: string[]): Output {
  const result = runCli([...args, "--format", "json"]);
  if (result.code !== 0) {
    throw new Error(`CLI failed (code ${result.code}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Output;
}

describe("find-arc CLI", () => {
  before(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "find-arc-test-"));
    sessionId = "11111111-1111-1111-1111-111111111111";

    const projectDir = join(projectsDir, "test-project");
    await mkdir(projectDir, { recursive: true });

    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const lines = [
      // Turns 1-2: unrelated chatter
      userTurn(1, "Let's talk about TypeScript types."),
      assistantTurn(2, "Sure, what about them?"),
      // Turns 3-4: first arc — discussion of CMV
      userTurn(3, "What do you think of claude-code-cmv?"),
      assistantTurn(4, "CMV review: it's a JSONL-level branching system with auto-trim. Useful for our practice."),
      // Turns 5-6: tool-only turns (no text)
      toolUseTurn(5, "Bash"),
      JSON.stringify({
        type: "user",
        uuid: uuid(6),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      }),
      // Turns 7-8: more unrelated chatter
      userTurn(7, "What about generics?"),
      assistantTurn(8, "Generics let you write reusable code."),
      // Turns 9-10: second arc — DCP discussion
      userTurn(9, "Tell me about DCP and OpenCode."),
      assistantTurn(10, "DCP is a context-pruning plugin for OpenCode. Different architecture from ours."),
      // Turns 11-12: a third place where 'CMV' appears
      userTurn(11, "Going back to CMV — would you adopt it?"),
      assistantTurn(12, "Not as-is, but the branching idea is portable."),
      // Turn 13: assistant turn with thinking + visible text
      assistantTurn(
        13,
        "<thinking>\nThe user asked about widgets.\n</thinking>\n\nWidgets are a great topic.",
      ),
      // Turn 14: assistant turn that's only thinking (visible text empty)
      assistantTurn(
        14,
        "<thinking>\nInternal-only deliberation about gadgets.\n</thinking>",
      ),
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");
  });

  after(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  it("returns JSON for matched query", () => {
    const out = runJson([sessionId, "claude-code-cmv"]);
    assert.equal(out.query, "claude-code-cmv");
    assert.equal(out.total_messages, 14);
    assert.ok(out.candidates.length >= 1);
    const top = out.candidates[0]!;
    assert.equal(top.match_kind, "phrase");
  });

  it("clusters consecutive hits into a single arc", () => {
    // "CMV" appears in turns 3, 4, and 11. With context=1, turns 3-4 cluster;
    // turn 11 is a separate arc.
    const out = runJson([sessionId, "CMV", "--context", "1"]);
    // Top candidate should have hits from turns 3 and 4
    const top = out.candidates[0]!;
    assert.equal(top.match_kind, "phrase");
    assert.equal(top.match_count, 2);
    // It expanded by context=1, so range is roughly turns 2-5 (clamped).
    assert.ok(top.uuids.length >= 2);
  });

  it("ranks by match count then turn count", () => {
    const out = runJson([sessionId, "CMV", "--context", "1"]);
    if (out.candidates.length >= 2) {
      const a = out.candidates[0]!;
      const b = out.candidates[1]!;
      assert.ok(
        a.match_count > b.match_count ||
          (a.match_count === b.match_count && a.turn_count >= b.turn_count),
      );
    }
  });

  it("falls back to all-words match when phrase not found", () => {
    const out = runJson([sessionId, "DCP OpenCode plugin"]);
    // No exact phrase match, but "DCP" + "OpenCode" + "plugin" all appear in turn 10
    assert.ok(out.candidates.length >= 1);
    assert.equal(out.candidates[0]!.match_kind, "all-words");
  });

  it("uses tag fallback for tool-only turns", () => {
    // Turn 5 is tool_use, turn 6 is tool_result. Search around them.
    const out = runJson([sessionId, "generics", "--context", "5"]);
    // Expansion may include tool turns; check that previews are non-empty
    // (either text or tag).
    for (const c of out.candidates) {
      assert.ok(c.first_preview.length > 0);
      assert.ok(c.last_preview.length > 0);
    }
  });

  it("respects --limit", () => {
    const out = runJson([sessionId, "CMV", "--context", "0", "--limit", "1"]);
    assert.equal(out.candidates.length, 1);
  });

  it("returns empty candidates when no match", () => {
    const out = runJson([sessionId, "nonexistent-phrase-xyzzy"]);
    assert.equal(out.candidates.length, 0);
  });

  it("returns text format by default", () => {
    const result = runCli([sessionId, "claude-code-cmv"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("candidate"));
    assert.ok(result.stdout.includes("first:"));
    assert.ok(result.stdout.includes("last:"));
  });

  it("errors on missing positional args", () => {
    const result = runCli([sessionId]);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("usage"));
  });

  it("errors on unknown session id", () => {
    const result = runCli(["99999999-9999-9999-9999-999999999999", "test"]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("no session JSONL"));
  });

  it("strips thinking blocks from previews but matches on them", () => {
    // "gadgets" only appears inside a <thinking> block in turn 14.
    // Match should still find it (matching reads thinking).
    // Preview should NOT contain it (preview strips thinking).
    const out = runJson([sessionId, "gadgets", "--context", "0"]);
    assert.equal(out.candidates.length, 1);
    const c = out.candidates[0]!;
    // Turn 14 has only thinking content; visible-text-after-stripping is empty,
    // so preview falls back to type tag.
    assert.ok(!c.first_preview.includes("gadgets"));
    assert.ok(!c.last_preview.includes("gadgets"));

    // "widgets" appears in visible text in turn 13. With --context 0 the arc
    // is exactly turn 13, so preview shows the visible portion.
    const widgetOut = runJson([sessionId, "widgets", "--context", "0"]);
    assert.equal(widgetOut.candidates.length, 1);
    const wc = widgetOut.candidates[0]!;
    assert.ok(wc.first_preview.includes("Widgets are a great topic"));
    // Thinking text from the same turn should not appear in preview
    assert.ok(!wc.first_preview.includes("user asked about widgets"));
  });

  it("includes estimated token counts", () => {
    const out = runJson([sessionId, "CMV", "--context", "0"]);
    for (const c of out.candidates) {
      assert.ok(c.estimated_tokens > 0);
      assert.ok(c.turn_count > 0);
      assert.equal(c.uuids.length, c.turn_count);
    }
  });
});
