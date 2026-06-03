import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import {
  createProxyServer,
  resolveSessionId,
  type ProxyConfig,
} from "../src/proxy/server.ts";
import { writeBlock } from "../src/shared/registry.ts";
import { sessionDir } from "../src/shared/paths.ts";
import { clearCaches } from "../src/proxy/cache.ts";
import type { Block } from "../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tempRoot: string;
const SESSION_ID = "test-proxy-session-aaaa";

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "shelving-proxy-test-"));
  process.env["CLAUDE_SHELVING_DIR"] = join(tempRoot, "shelving");
  process.env["CLAUDE_PROJECTS_DIR"] = join(tempRoot, "projects");
  await mkdir(process.env["CLAUDE_SHELVING_DIR"], { recursive: true });
  await mkdir(process.env["CLAUDE_PROJECTS_DIR"], { recursive: true });
});

after(async () => {
  delete process.env["CLAUDE_SHELVING_DIR"];
  delete process.env["CLAUDE_PROJECTS_DIR"];
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset state between tests
  clearCaches();
  await rm(sessionDir(SESSION_ID), { recursive: true, force: true });
  const projDir = join(process.env["CLAUDE_PROJECTS_DIR"]!, "-test-proj");
  await rm(projDir, { recursive: true, force: true });
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeUpstream {
  url: URL;
  captured: CapturedRequest[];
  /** Fixed response body to return for all requests. */
  responseBody: string | Buffer;
  responseStatus: number;
  responseContentType: string;
  responseHeaders: Record<string, string>;
  close: () => Promise<void>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const captured: CapturedRequest[] = [];
  const upstream: FakeUpstream = {
    url: null as unknown as URL,
    captured,
    responseBody: '{"id":"msg_test","content":[{"type":"text","text":"ok"}]}',
    responseStatus: 200,
    responseContentType: "application/json",
    responseHeaders: {},
    close: async () => {},
  };

  const server: Server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(", ");
        }
        captured.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers,
          body,
        });
        res.writeHead(upstream.responseStatus, {
          "content-type": upstream.responseContentType,
          ...upstream.responseHeaders,
        });
        res.end(upstream.responseBody);
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  upstream.url = new URL(`http://127.0.0.1:${addr.port}`);
  upstream.close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return upstream;
}

async function startProxy(upstream: URL): Promise<{
  url: URL;
  close: () => Promise<void>;
}> {
  const config: ProxyConfig = {
    port: 0,
    bind: "127.0.0.1",
    upstream,
    logLevel: "silent",
  };
  const server = createProxyServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${addr.port}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeSessionJsonl(
  sessionId: string,
  entries: Array<{ uuid: string; role: "user" | "assistant"; content: string }>,
): Promise<void> {
  const projectsDir = process.env["CLAUDE_PROJECTS_DIR"]!;
  const projDir = join(projectsDir, "-test-proj");
  await mkdir(projDir, { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({
      type: e.role,
      uuid: e.uuid,
      message: { role: e.role, content: e.content },
      sessionId,
    }),
  );
  await writeFile(join(projDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

async function writeRawSessionJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const projectsDir = process.env["CLAUDE_PROJECTS_DIR"]!;
  const projDir = join(projectsDir, "-test-proj");
  await mkdir(projDir, { recursive: true });
  await writeFile(
    join(projDir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

function makeBlock(overrides: Partial<Block>): Block {
  return {
    block_id: 1,
    created_at: "2026-05-08T14:30:00Z",
    active: true,
    anchor_uuid: "u1",
    compressed_uuids: ["u1"],
    summary: "summary",
    original_tokens: 100,
    summary_tokens: 10,
    focus: null,
    parent_block_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveSessionId unit tests (no I/O)
// ---------------------------------------------------------------------------

test("resolveSessionId: x-claude-code-session-id header", () => {
  assert.equal(
    resolveSessionId({ "x-claude-code-session-id": "abc" }),
    "abc",
  );
});

test("resolveSessionId: x-session-id fallback", () => {
  assert.equal(resolveSessionId({ "x-session-id": "def" }), "def");
});

test("resolveSessionId: returns null when no header present", () => {
  assert.equal(resolveSessionId({ "content-type": "application/json" }), null);
});

test("resolveSessionId: handles array header values", () => {
  assert.equal(
    resolveSessionId({
      "x-claude-code-session-id": ["first", "second"],
    }),
    "first",
  );
});

// ---------------------------------------------------------------------------
// End-to-end integration tests
// ---------------------------------------------------------------------------

test("E2E: passthrough when no session header", async () => {
  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hello" }],
    });
    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reqBody,
    });
    assert.equal(res.status, 200);

    assert.equal(upstream.captured.length, 1);
    assert.equal(upstream.captured[0]?.body, reqBody);
    assert.equal(upstream.captured[0]?.headers["accept-encoding"], "identity");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: passthrough when no active blocks for session", async () => {
  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hello" }],
    });
    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.captured[0]?.body, reqBody);
    assert.equal(upstream.captured[0]?.headers["accept-encoding"], "identity");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: gzipped upstream responses are decoded once for downstream clients", async () => {
  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const plainBody = '{"id":"msg_test","content":[{"type":"text","text":"ok"}]}';
    const compressedBody = gzipSync(Buffer.from(plainBody, "utf-8"));
    upstream.responseBody = compressedBody;
    upstream.responseHeaders = {
      "content-encoding": "gzip",
      "content-length": String(compressedBody.length),
    };

    const res = await fetch(new URL("/v1/messages?beta=true", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), plainBody);
    assert.equal(upstream.captured[0]?.headers["accept-encoding"], "identity");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: SSE responses get a turn marker injected before first text delta", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "a1", role: "assistant", content: "msg2" },
    { uuid: "u2", role: "user", content: "msg3" },
  ]);

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    // Real turns run with thinking enabled: index 0 is a thinking block and
    // the visible text block lands at index 1. The marker must be detected at,
    // and injected against, that text index — not a hardcoded index 0.
    upstream.responseContentType = "text/event-stream";
    upstream.responseBody =
      'event: message_start\n' +
      'data: {"type":"message_start"}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}\n\n';

    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        thinking: { type: "adaptive", display: "summarized" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    // Marker injected as a text_delta against index 1, after the text block
    // starts and before the upstream "hello" delta.
    assert.match(
      body,
      /"type":"content_block_start","index":1[\s\S]*event: content_block_delta\ndata: \{"type": "content_block_delta", "index": 1, "delta": \{"type": "text_delta", "text": "\[turn 5\]\\n\\n"\}\}\n\nevent: content_block_delta[\s\S]*"text":"hello"/,
    );
    // The thinking block at index 0 must be left untouched.
    assert.doesNotMatch(body, /"index": 0, "delta": \{"type": "text_delta", "text": "\[turn/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: SSE turn marker uses collapsed UUID turn numbering", async () => {
  await writeRawSessionJsonl(SESSION_ID, [
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "msg1" },
    },
    {
      type: "assistant",
      uuid: "dup",
      message: { role: "assistant", content: "first half of duplicated turn" },
    },
    {
      type: "assistant",
      uuid: "dup",
      message: { role: "assistant", content: "second half of duplicated turn" },
    },
    {
      type: "user",
      uuid: "u3",
      message: { role: "user", content: "msg3" },
    },
  ]);

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    upstream.responseContentType = "text/event-stream";
    upstream.responseBody =
      'event: message_start\n' +
      'data: {"type":"message_start"}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';

    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        thinking: { type: "adaptive", display: "summarized" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /\[turn 5\]\\n\\n/);
    assert.doesNotMatch(body, /\[turn 4\]\\n\\n/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: auxiliary requests (single message, no thinking) get no turn marker", async () => {
  // Title generation / quota pings are single-message and carry no `thinking`.
  // Injecting a marker prepends "[turn N]\n\n" onto the JSON they emit and
  // corrupts CC-side parsing, so they must be left alone even though their
  // upstream stream opens with a text block at index 0.
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "a1", role: "assistant", content: "msg2" },
    { uuid: "u2", role: "user", content: "msg3" },
  ]);

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    upstream.responseContentType = "text/event-stream";
    upstream.responseBody =
      'event: message_start\n' +
      'data: {"type":"message_start"}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"title\\":\\"x\\"}"}}\n\n';

    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        messages: [{ role: "user", content: "name this chat" }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.doesNotMatch(body, /\[turn/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: substitutes anchor and drops covered messages", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u_pre", role: "user", content: "pre" },
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "u2", role: "assistant", content: "msg2" },
    { uuid: "u3", role: "user", content: "msg3" },
    { uuid: "u_post", role: "user", content: "post" },
  ]);
  await writeBlock(
    SESSION_ID,
    makeBlock({
      block_id: 1,
      anchor_uuid: "u1",
      compressed_uuids: ["u1", "u2", "u3"],
      summary: "Three messages, collapsed.",
      focus: "decisions about auth",
    }),
  );

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "pre" },
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "user", content: "post" },
      ],
    });
    const res = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: reqBody,
    });
    assert.equal(res.status, 200);

    const upstreamBody = JSON.parse(upstream.captured[0]?.body ?? "{}");
    // pre / summary / post are all user-role, so they fold into one well-formed
    // message. No two adjacent messages may share a role.
    for (let i = 1; i < upstreamBody.messages.length; i++) {
      assert.notEqual(upstreamBody.messages[i].role, upstreamBody.messages[i - 1].role);
    }
    const text = JSON.stringify(upstreamBody.messages);
    assert.match(text, /pre/);
    assert.match(text, /Three messages, collapsed\./);
    assert.match(text, /\[shelved: block 1, 3 messages — decisions about auth\]/);
    assert.match(text, /post/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: cache stability — repeat request produces byte-identical upstream body", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "u2", role: "assistant", content: "msg2" },
    { uuid: "u3", role: "user", content: "msg3" },
  ]);
  await writeBlock(
    SESSION_ID,
    makeBlock({
      block_id: 1,
      anchor_uuid: "u1",
      compressed_uuids: ["u1", "u2"],
      summary: "Collapsed.",
    }),
  );

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
      ],
    });
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": SESSION_ID,
    };
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    assert.equal(upstream.captured.length, 3);
    assert.equal(upstream.captured[0]?.body, upstream.captured[1]?.body);
    assert.equal(upstream.captured[1]?.body, upstream.captured[2]?.body);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: decompress restores original content on next request", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "u2", role: "user", content: "msg2" },
  ]);
  await writeBlock(
    SESSION_ID,
    makeBlock({
      block_id: 1,
      anchor_uuid: "u1",
      compressed_uuids: ["u1", "u2"],
      summary: "Collapsed.",
    }),
  );

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      messages: [
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
      ],
    });
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": SESSION_ID,
    };

    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    // Decompress: flip active to false
    await writeBlock(
      SESSION_ID,
      makeBlock({
        block_id: 1,
        active: false,
        anchor_uuid: "u1",
        compressed_uuids: ["u1", "u2"],
        summary: "Collapsed.",
      }),
    );

    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    assert.equal(upstream.captured.length, 2);
    const first = JSON.parse(upstream.captured[0]?.body ?? "{}");
    const second = JSON.parse(upstream.captured[1]?.body ?? "{}");
    assert.equal(first.messages.length, 1, "first request had compressed messages");
    assert.equal(second.messages.length, 2, "second request had original messages");
    assert.equal(second.messages[0].content, "msg1");
    assert.equal(second.messages[1].content, "msg2");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: recompress (re-activate) returns to compressed state", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "u2", role: "user", content: "msg2" },
  ]);

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      messages: [
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
      ],
    });
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": SESSION_ID,
    };

    // Compressed initially
    await writeBlock(
      SESSION_ID,
      makeBlock({
        block_id: 1,
        active: true,
        anchor_uuid: "u1",
        compressed_uuids: ["u1", "u2"],
        summary: "Collapsed.",
      }),
    );
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    // Decompress
    await writeBlock(
      SESSION_ID,
      makeBlock({
        block_id: 1,
        active: false,
        anchor_uuid: "u1",
        compressed_uuids: ["u1", "u2"],
        summary: "Collapsed.",
      }),
    );
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    // Recompress
    await writeBlock(
      SESSION_ID,
      makeBlock({
        block_id: 1,
        active: true,
        anchor_uuid: "u1",
        compressed_uuids: ["u1", "u2"],
        summary: "Collapsed.",
      }),
    );
    await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: reqBody,
    });

    assert.equal(upstream.captured.length, 3);
    assert.equal(upstream.captured[0]?.body, upstream.captured[2]?.body);
    assert.notEqual(upstream.captured[0]?.body, upstream.captured[1]?.body);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: /health returns 200 without hitting upstream", async () => {
  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(new URL("/health", proxy.url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["status"], "ok");
    assert.equal(upstream.captured.length, 0, "/health should not forward upstream");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: non-/v1/messages endpoints pass through to upstream", async () => {
  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(new URL("/v1/some-other-endpoint", proxy.url));
    assert.equal(res.status, 200);
    assert.equal(upstream.captured.length, 1);
    assert.equal(upstream.captured[0]?.url, "/v1/some-other-endpoint");
    assert.equal(upstream.captured[0]?.headers["accept-encoding"], "identity");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("E2E: /v1/messages subpaths pass through unchanged and preserve path", async () => {
  await writeSessionJsonl(SESSION_ID, [
    { uuid: "u1", role: "user", content: "msg1" },
    { uuid: "u2", role: "assistant", content: "msg2" },
  ]);
  await writeBlock(
    SESSION_ID,
    makeBlock({
      block_id: 1,
      anchor_uuid: "u1",
      compressed_uuids: ["u1", "u2"],
      summary: "Collapsed.",
    }),
  );

  const upstream = await startFakeUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const reqBody = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
      ],
    });

    const res = await fetch(new URL("/v1/messages/count_tokens?beta=true", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": SESSION_ID,
      },
      body: reqBody,
    });

    assert.equal(res.status, 200);
    assert.equal(upstream.captured.length, 1);
    assert.equal(upstream.captured[0]?.url, "/v1/messages/count_tokens?beta=true");
    assert.equal(upstream.captured[0]?.body, reqBody);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
