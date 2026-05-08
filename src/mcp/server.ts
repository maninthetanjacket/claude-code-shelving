#!/usr/bin/env node
/**
 * Shelving MCP server.
 *
 * Exposes compress / decompress / recompress / list_compressions as
 * model-callable tools. State is persisted to ~/.claude/shelving/<session>/
 * (override via CLAUDE_SHELVING_DIR env var).
 *
 * Run via: tsx src/mcp/server.ts (dev) or node dist/mcp/server.js (prod).
 * Connects via stdio per MCP convention; CC starts the server and
 * communicates over stdin/stdout.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { TOOLS, dispatch } from "./tools.js";

const server = new Server(
  {
    name: "claude-code-shelving",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return dispatch(name, args);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio MCP traffic on stdout.
  process.stderr.write("claude-code-shelving MCP server ready\n");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
