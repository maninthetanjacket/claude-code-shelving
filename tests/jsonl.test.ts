import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findSessionJsonl,
  parseSessionJsonl,
  loadSessionMessages,
} from "../src/proxy/jsonl.ts";

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-jsonl-test-"));
  process.env["CLAUDE_PROJECTS_DIR"] = tempRoot;
});

after(async () => {
  delete process.env["CLAUDE_PROJECTS_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean projects dir between tests
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

async function writeJsonl(
  projectSlug: string,
  sessionId: string,
  lines: object[],
): Promise<string> {
  const dir = join(tempRoot, projectSlug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("findSessionJsonl returns null when no projects exist", async () => {
  const result = await findSessionJsonl("nonexistent-session");
  assert.equal(result, null);
});

test("findSessionJsonl finds the file by session id across project dirs", async () => {
  const sessionId = "test-session-123";
  await writeJsonl("-some-project", "other-session", [{ type: "user" }]);
  const expectedPath = await writeJsonl("-target-project", sessionId, [
    { type: "user" },
  ]);

  const found = await findSessionJsonl(sessionId);
  assert.equal(found, expectedPath);
});

test("findSessionJsonl returns null when session id doesn't match any file", async () => {
  await writeJsonl("-some-project", "other-session", [{ type: "user" }]);
  const found = await findSessionJsonl("missing-session");
  assert.equal(found, null);
});

test("parseSessionJsonl extracts user and assistant messages with uuid", async () => {
  const path = await writeJsonl("-test", "s1", [
    { type: "queue-operation", operation: "enqueue" },
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hello" },
    },
    {
      type: "assistant",
      uuid: "u2",
      message: { role: "assistant", content: "hi back" },
    },
    { type: "queue-operation", operation: "dequeue" },
  ]);

  const messages = await parseSessionJsonl(path);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.uuid, "u1");
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content, "hello");
  assert.equal(messages[1]?.uuid, "u2");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, "hi back");
});

test("parseSessionJsonl handles array-form content", async () => {
  const arrayContent = [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
  ];
  const path = await writeJsonl("-test", "s1", [
    {
      type: "assistant",
      uuid: "u1",
      message: { role: "assistant", content: arrayContent },
    },
  ]);

  const messages = await parseSessionJsonl(path);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.content, arrayContent);
});

test("parseSessionJsonl skips invalid lines silently", async () => {
  const path = join(tempRoot, "-test", "s1.jsonl");
  await mkdir(join(tempRoot, "-test"), { recursive: true });
  await writeFile(
    path,
    [
      "not valid json",
      "",
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hello" },
      }),
      "{broken",
      JSON.stringify({ type: "user" }), // missing uuid
      JSON.stringify({ type: "user", uuid: "u2", message: { role: "user" } }), // missing content
      JSON.stringify({
        type: "assistant",
        uuid: "u3",
        message: { role: "assistant", content: "valid" },
      }),
    ].join("\n"),
  );

  const messages = await parseSessionJsonl(path);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.uuid, "u1");
  assert.equal(messages[1]?.uuid, "u3");
});

test("parseSessionJsonl skips entries with non-user/assistant role in message", async () => {
  const path = await writeJsonl("-test", "s1", [
    {
      type: "user",
      uuid: "u1",
      message: { role: "system", content: "system msg" },
    },
    {
      type: "user",
      uuid: "u2",
      message: { role: "user", content: "real" },
    },
  ]);

  const messages = await parseSessionJsonl(path);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.uuid, "u2");
});

test("loadSessionMessages returns empty when session not found", async () => {
  const result = await loadSessionMessages("missing-session");
  assert.equal(result.path, null);
  assert.equal(result.mtime, null);
  assert.deepEqual(result.messages, []);
});

test("loadSessionMessages returns path, mtime, and parsed messages", async () => {
  await writeJsonl("-test", "s1", [
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hello" },
    },
  ]);

  const result = await loadSessionMessages("s1");
  assert.notEqual(result.path, null);
  assert.equal(typeof result.mtime, "number");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.uuid, "u1");
});
