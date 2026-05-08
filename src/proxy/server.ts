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
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { applySubstitutions } from "./transform.js";
import { getActiveBlocksCached, getJsonlMessagesCached } from "./cache.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  port: number;
  bind: string;
  upstream: URL;
  logLevel: "silent" | "info" | "debug";
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
  return { port, bind, upstream, logLevel };
}

function makeLogger(level: ProxyConfig["logLevel"]) {
  return (which: "info" | "debug", msg: string): void => {
    if (level === "silent") return;
    if (which === "debug" && level !== "debug") return;
    process.stderr.write(`[shelving-proxy] ${msg}\n`);
  };
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
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  if (newBodyLength !== null) {
    out["content-length"] = String(newBodyLength);
  }
  return out;
}

function buildResponseHeaders(
  upstream: Response,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // fetch() transparently decodes compressed upstream responses, so forwarding
    // the original encoding/length headers would make downstream clients try to
    // decode an already-decoded body.
    if (
      lower === "transfer-encoding" ||
      lower === "content-encoding" ||
      lower === "content-length"
    ) {
      return;
    }
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  });
  return out;
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
  const bodyBuf = await readBody(req);
  let modifiedBuf = bodyBuf;
  let transformInfo = "passthrough";

  const sessionId = resolveSessionId(req.headers);
  if (sessionId !== null) {
    try {
      const [activeBlocks, jsonlMessages] = await Promise.all([
        getActiveBlocksCached(sessionId),
        getJsonlMessagesCached(sessionId),
      ]);

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
    }
  } else {
    transformInfo = "passthrough (no session id)";
  }

  log("debug", `POST /v1/messages session=${sessionId ?? "?"} ${transformInfo}`);

  const upstreamUrl = new URL("/v1/messages", config.upstream);
  const reqUrl = new URL(req.url ?? "/", "http://placeholder");
  for (const [k, v] of reqUrl.searchParams.entries()) {
    upstreamUrl.searchParams.append(k, v);
  }

  const upstreamHeaders = buildUpstreamHeaders(req.headers, modifiedBuf.length);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: new Uint8Array(modifiedBuf),
  });

  const respHeaders = buildResponseHeaders(upstreamRes);
  res.writeHead(upstreamRes.status, respHeaders);

  if (upstreamRes.body !== null) {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(Buffer.from(value));
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Generic passthrough
// ---------------------------------------------------------------------------

async function handlePassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
): Promise<void> {
  const upstreamUrl = new URL(req.url ?? "/", config.upstream);
  const bodyBuf =
    req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const upstreamHeaders = buildUpstreamHeaders(
    req.headers,
    bodyBuf ? bodyBuf.length : null,
  );

  const upstreamRes = await fetch(upstreamUrl, {
    method: req.method ?? "GET",
    headers: upstreamHeaders,
    body: bodyBuf === undefined ? undefined : new Uint8Array(bodyBuf),
  });
  const respHeaders = buildResponseHeaders(upstreamRes);
  res.writeHead(upstreamRes.status, respHeaders);
  if (upstreamRes.body !== null) {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(Buffer.from(value));
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Public API: build a server, optionally start it
// ---------------------------------------------------------------------------

export function createProxyServer(config: ProxyConfig): Server {
  const log = makeLogger(config.logLevel);

  return createHttpServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", upstream: config.upstream.toString() }),
      );
      return;
    }

    const handler =
      req.method === "POST" && req.url?.startsWith("/v1/messages")
        ? (r: IncomingMessage, w: ServerResponse) =>
            handleMessages(r, w, config, log)
        : (r: IncomingMessage, w: ServerResponse) =>
            handlePassthrough(r, w, config);

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
