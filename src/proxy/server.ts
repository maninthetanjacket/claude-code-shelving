#!/usr/bin/env node
/**
 * Shelving proxy server.
 *
 * Listens on a configurable port (default 9802). For POST /v1/messages
 * requests, looks up the session's active blocks and applies substitutions
 * before forwarding upstream. All other requests pass through unchanged.
 *
 * Configuration (env vars):
 *   SHELVING_PROXY_PORT          (default 9802)
 *   SHELVING_PROXY_BIND          (default 127.0.0.1)
 *   SHELVING_PROXY_UPSTREAM      (default https://api.anthropic.com)
 *   SHELVING_PROXY_LOG_LEVEL     (default info; one of: silent | info | debug)
 *
 *   CLAUDE_SHELVING_DIR          (registry root, see shared/paths.ts)
 *   CLAUDE_PROJECTS_DIR          (CC projects dir, see proxy/jsonl.ts)
 *
 * To use with CC:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude
 *
 * To chain through cache-fix-proxy:
 *   SHELVING_PROXY_UPSTREAM=http://127.0.0.1:9801 (cache-fix-proxy)
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude
 */

import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applySubstitutions } from "./transform.js";
import { getActiveBlocksCached, getJsonlMessagesCached } from "./cache.js";
import { loadSessionMessages } from "./jsonl.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  port: number;
  bind: string;
  upstream: URL;
  logLevel: "silent" | "info" | "debug";
  /**
   * If set, every /v1/messages request is dumped to this directory as a JSON
   * file containing the original body, transformed body (if changed), and
   * substitution metadata. Useful for debugging why substitutions aren't
   * applying as expected. Disabled when undefined.
   */
  dumpDir?: string;
}

export function loadConfigFromEnv(): ProxyConfig {
  const port = Number.parseInt(process.env["SHELVING_PROXY_PORT"] ?? "9802", 10);
  const bind = process.env["SHELVING_PROXY_BIND"] ?? "127.0.0.1";
  const upstreamRaw =
    process.env["SHELVING_PROXY_UPSTREAM"] ?? "https://api.anthropic.com";
  const upstream = new URL(upstreamRaw);
  const rawLevel = process.env["SHELVING_PROXY_LOG_LEVEL"] ?? "info";
  const logLevel: ProxyConfig["logLevel"] =
    rawLevel === "silent" || rawLevel === "debug" ? rawLevel : "info";
  const dumpDirRaw = process.env["SHELVING_PROXY_DUMP_DIR"];
  const dumpDir =
    dumpDirRaw !== undefined && dumpDirRaw.length > 0 ? dumpDirRaw : undefined;
  const config: ProxyConfig = { port, bind, upstream, logLevel };
  if (dumpDir !== undefined) config.dumpDir = dumpDir;
  return config;
}

function makeLogger(level: ProxyConfig["logLevel"]) {
  return (which: "info" | "debug", msg: string): void => {
    if (level === "silent") return;
    if (which === "debug" && level !== "debug") return;
    process.stderr.write(`[shelving-proxy] ${msg}\n`);
  };
}

function requestPathname(reqUrl: string | undefined): string {
  return new URL(reqUrl ?? "/", "http://placeholder").pathname;
}

// ---------------------------------------------------------------------------
// Session id extraction (mirrors cache-fix-proxy/cache-telemetry.mjs)
// ---------------------------------------------------------------------------

export function resolveSessionId(
  headers: IncomingMessage["headers"],
): string | null {
  const candidates = [
    "x-claude-code-session-id",
    "x-session-id",
    "x-anthropic-session-id",
  ];
  for (const k of candidates) {
    const v = headers[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && v[0] !== undefined && v[0].length > 0) return v[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body buffering
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Header forwarding
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function buildUpstreamHeaders(
  reqHeaders: IncomingMessage["headers"],
  newBodyLength: number | null,
  upstreamHostname: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  out["host"] = upstreamHostname;
  // Force plaintext so stream framing stays stable for downstream clients and
  // for any future SSE-aware proxy logic.
  out["accept-encoding"] = "identity";
  if (newBodyLength !== null) {
    out["content-length"] = String(newBodyLength);
  }
  return out;
}

function buildResponseHeaders(
  upstreamHeaders: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "transfer-encoding") continue;
    if (Array.isArray(value)) {
      out[key] = value.map(String);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function isSseContentType(
  contentType: string | string[] | undefined,
): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === "string" && value.toLowerCase().startsWith("text/event-stream");
}

function adjustResponseHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  if (!isSseContentType(headers["content-type"])) {
    return headers;
  }

  const adjusted = { ...headers };
  delete adjusted["content-length"];
  delete adjusted["Content-Length"];
  return adjusted;
}

function collapseConsecutiveDuplicates(values: string[]): string[] {
  const collapsed: string[] = [];
  for (const value of values) {
    if (collapsed[collapsed.length - 1] !== value) {
      collapsed.push(value);
    }
  }
  return collapsed;
}

interface ForwardedResponse {
  upstreamRes: IncomingMessage;
  statusCode: number;
  responseHeaders: Record<string, string | string[]>;
}

function forwardUpstream(
  req: IncomingMessage,
  upstreamUrl: URL,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = upstreamUrl.protocol === "https:";
    const requestImpl = isHttps ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port:
        upstreamUrl.port.length > 0
          ? Number.parseInt(upstreamUrl.port, 10)
          : isHttps
            ? 443
            : 80,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: req.method ?? "GET",
      headers,
    };

    const upstreamReq: ClientRequest = requestImpl(options, (upstreamRes) => {
      resolve({
        upstreamRes,
        statusCode: upstreamRes.statusCode ?? 502,
        responseHeaders: buildResponseHeaders(upstreamRes.headers),
      });
    });

    upstreamReq.on("error", reject);

    if (signal !== undefined) {
      signal.addEventListener(
        "abort",
        () => {
          upstreamReq.destroy(new Error("Request aborted"));
        },
        { once: true },
      );
    }

    if (body !== undefined) {
      upstreamReq.end(body);
    } else {
      upstreamReq.end();
    }
  });
}

async function pipeUpstreamResponse(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  sessionId: string | null,
  config: ProxyConfig,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  const shouldDumpResponse = config.dumpDir !== undefined && sessionId !== null;
  const shouldInjectTurnMarker =
    sessionId !== null && isSseContentType(upstreamRes.headers["content-type"]);

  log("debug", `starting pipeUpstreamResponse for session ${sessionId ?? "null"}`);

  let turnNumber: number | null = null;
  if (shouldInjectTurnMarker) {
    try {
      const { messages } = await loadSessionMessages(sessionId);
      // At response time, Claude Code may not have appended the current user
      // turn to the transcript yet. Inject the marker for the assistant reply's
      // eventual transcript turn so the visible [turn N] aligns with the
      // persisted JSONL numbering used by the MCP server.
      turnNumber =
        collapseConsecutiveDuplicates(messages.map((message) => message.uuid)).length + 2;
    } catch (err) {
      log(
        "info",
        `failed to load turn number: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const responseChunks: Buffer[] = [];
  const captureChunk = (chunk: Buffer): void => {
    if (shouldDumpResponse) responseChunks.push(chunk);
  };
  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    captureChunk(chunk);
    const ok = res.write(chunk);
    if (!ok) {
      await once(res, "drain");
    }
  };

  if (!shouldInjectTurnMarker || turnNumber === null) {
    for await (const chunk of upstreamRes) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await writeChunk(buf);
    }
  } else {
    let injected = false;
    let buffer = "";

    for await (const chunk of upstreamRes) {
      buffer += chunk.toString("utf-8");

      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n");
        const event = buffer.slice(0, index + 2);
        buffer = buffer.slice(index + 2);
        const eventBuf = Buffer.from(event);

        await writeChunk(eventBuf);
        if (
          !injected &&
          event.includes('"type":"content_block_start","index":0,"content_block":{"type":"text"')
        ) {
          log("debug", `detected content_block_start, injecting turn ${turnNumber}`);
          const markerBuf = Buffer.from(
            `event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "[turn ${turnNumber}]\\n\\n"}}\n\n`,
          );
          await writeChunk(markerBuf);
          injected = true;
        }
      }
    }

    if (buffer.length > 0) {
      await writeChunk(Buffer.from(buffer));
    }
  }

  log("debug", `finished piping chunks for session ${sessionId ?? "null"}`);

  if (shouldDumpResponse) {
    try {
      const fullResponse = Buffer.concat(responseChunks);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await mkdir(config.dumpDir!, { recursive: true });
      await writeFile(
        join(config.dumpDir!, `response-${sessionId}-${timestamp}.raw`),
        fullResponse,
      );
      log("debug", `dumped response to ${config.dumpDir}/response-${sessionId}-${timestamp}.raw`);
    } catch (err) {
      log("info", `response dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  res.end();
}

// ---------------------------------------------------------------------------
// Debug dump
// ---------------------------------------------------------------------------

let dumpSeq = 0;

async function writeDump(
  dumpDir: string,
  meta: Record<string, unknown>,
  originalBody: Buffer,
  modifiedBody: Buffer,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  try {
    await mkdir(dumpDir, { recursive: true });
    dumpSeq += 1;
    const seq = String(dumpSeq).padStart(5, "0");
    const stem = `${(meta["timestamp"] as string).replace(/[:.]/g, "-")}-${seq}`;

    // Always write metadata
    await writeFile(
      join(dumpDir, `${stem}.meta.json`),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8",
    );

    // Always write the original body (what CC sent)
    await writeFile(join(dumpDir, `${stem}.original.json`), originalBody, {
      encoding: "utf-8",
    });

    // Write the transformed body only if it differs from the original
    if (modifiedBody !== originalBody) {
      await writeFile(join(dumpDir, `${stem}.transformed.json`), modifiedBody, {
        encoding: "utf-8",
      });
    }

    log("debug", `dumped request artifacts to ${dumpDir}/${stem}.*`);
  } catch (err) {
    log(
      "info",
      `dump write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// /v1/messages handler
// ---------------------------------------------------------------------------

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.on("aborted", abortUpstream);
  req.on("close", abortUpstream);
  res.on("close", abortUpstream);

  const bodyBuf = await readBody(req);
  let modifiedBuf = bodyBuf;
  let transformInfo = "passthrough";

  // Captured for the dump file when SHELVING_PROXY_DUMP_DIR is set.
  let dumpMeta: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    url: req.url,
    transform_info: transformInfo,
  };

  const sessionId = resolveSessionId(req.headers);
  if (sessionId !== null) {
    try {
      const [activeBlocks, jsonlMessages] = await Promise.all([
        getActiveBlocksCached(sessionId),
        getJsonlMessagesCached(sessionId),
      ]);

      dumpMeta["session_id"] = sessionId;
      dumpMeta["active_block_ids"] = activeBlocks.map((b) => b.block_id);
      dumpMeta["jsonl_message_count"] = jsonlMessages.length;

      if (activeBlocks.length > 0) {
        const parsed = JSON.parse(bodyBuf.toString("utf-8"));
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          Array.isArray(parsed.messages)
        ) {
          const result = applySubstitutions(parsed, jsonlMessages, activeBlocks);
          modifiedBuf = Buffer.from(JSON.stringify(result.request), "utf-8");
          transformInfo =
            `applied blocks=[${result.blocks_applied.join(",")}] ` +
            `substituted=${result.anchors_substituted} ` +
            `dropped=${result.messages_dropped}`;
          dumpMeta["request_message_count"] = parsed.messages.length;
          dumpMeta["transformed_message_count"] = result.request.messages.length;
          dumpMeta["blocks_applied"] = result.blocks_applied;
          dumpMeta["blocks_inactive_in_request"] = result.blocks_inactive_in_request;
          dumpMeta["anchors_substituted"] = result.anchors_substituted;
          dumpMeta["messages_dropped"] = result.messages_dropped;
        } else {
          transformInfo = "passthrough (no messages array)";
        }
      } else {
        transformInfo = "passthrough (no active blocks)";
      }
    } catch (err) {
      log(
        "info",
        `transform error, passing through: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      modifiedBuf = bodyBuf;
      transformInfo = "passthrough (transform error)";
      dumpMeta["transform_error"] =
        err instanceof Error ? err.message : String(err);
    }
  } else {
    transformInfo = "passthrough (no session id)";
  }

  dumpMeta["transform_info"] = transformInfo;
  dumpMeta["body_changed"] = modifiedBuf !== bodyBuf;

  log("debug", `POST /v1/messages session=${sessionId ?? "?"} ${transformInfo}`);

  // Dump if configured. Done before forwarding so we capture even if upstream errors.
  if (config.dumpDir !== undefined) {
    void writeDump(config.dumpDir, dumpMeta, bodyBuf, modifiedBuf, log);
  }

  const upstreamUrl = new URL(req.url ?? "/", config.upstream);

  const upstreamHeaders = buildUpstreamHeaders(
    req.headers,
    modifiedBuf.length,
    upstreamUrl.hostname,
  );

  const upstream = await forwardUpstream(
    req,
    upstreamUrl,
    upstreamHeaders,
    modifiedBuf,
    abortController.signal,
  );
  res.writeHead(upstream.statusCode, adjustResponseHeaders(upstream.responseHeaders));
  await pipeUpstreamResponse(upstream.upstreamRes, res, sessionId, config, log);
}

// ---------------------------------------------------------------------------
// Generic passthrough
// ---------------------------------------------------------------------------

async function handlePassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.on("aborted", abortUpstream);
  req.on("close", abortUpstream);
  res.on("close", abortUpstream);

  const sessionId = resolveSessionId(req.headers);
  const upstreamUrl = new URL(req.url ?? "/", config.upstream);
  const bodyBuf =
    req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const upstreamHeaders = buildUpstreamHeaders(
    req.headers,
    bodyBuf ? bodyBuf.length : null,
    upstreamUrl.hostname,
  );

  const upstream = await forwardUpstream(
    req,
    upstreamUrl,
    upstreamHeaders,
    bodyBuf,
    abortController.signal,
  );
  res.writeHead(upstream.statusCode, adjustResponseHeaders(upstream.responseHeaders));
  await pipeUpstreamResponse(upstream.upstreamRes, res, sessionId, config, log);
}

// ---------------------------------------------------------------------------
// Public API: build a server, optionally start it
// ---------------------------------------------------------------------------

export function createProxyServer(config: ProxyConfig): Server {
  const log = makeLogger(config.logLevel);

  return createHttpServer((req, res) => {
    const pathname = requestPathname(req.url);

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", upstream: config.upstream.toString() }),
      );
      return;
    }

    const handler =
      req.method === "POST" && pathname === "/v1/messages"
        ? (r: IncomingMessage, w: ServerResponse) =>
            handleMessages(r, w, config, log)
        : (r: IncomingMessage, w: ServerResponse) =>
            handlePassthrough(r, w, config, log);

    handler(req, res).catch((err) => {
      log(
        "info",
        `handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "shelving proxy upstream error",
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      } else {
        res.end();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Script entry
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  // process.argv[1] is the script path being executed
  if (typeof process.argv[1] !== "string") return false;
  // import.meta.url ends with the same path under tsx/node ESM
  const url = import.meta.url;
  return url.endsWith(process.argv[1]) || url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const config = loadConfigFromEnv();
  const log = makeLogger(config.logLevel);
  const server = createProxyServer(config);
  server.listen(config.port, config.bind, () => {
    log(
      "info",
      `claude-code-shelving proxy listening on http://${config.bind}:${config.port} → ${config.upstream}`,
    );
  });
}
