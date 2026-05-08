import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  listBlocks,
  nextBlockId,
  setBlockActive,
  writeBlock,
} from "../shared/registry.js";
import { blockToMeta, type Block } from "../shared/types.js";
import {
  requireNonEmptyString,
  requireStringArray,
  requirePositiveInt,
  optionalNonNegativeInt,
  optionalString,
  resolveSessionIdArg,
  ValidationError,
} from "./validate.js";

/**
 * Tool definitions and handlers for the shelving MCP server.
 *
 * Tool descriptions follow a deliberate-practice register: they describe
 * what the tool does mechanically, not when the model should use it.
 * No "use this when context fills up", no "important for performance",
 * no urgency framing. The model decides when shelving is appropriate;
 * the description gives only the mechanism.
 */

// ----------------------------------------------------------------------------
// Tool schemas (JSON Schema for MCP)
// ----------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "compress",
    description:
      "Compresses a range of messages in a Claude Code session into a single summary. " +
      "On subsequent API requests, the proxy substitutes the summary for the anchor message and drops the rest of the range. " +
      "The original conversation is preserved in the session JSONL on disk and can be restored via decompress. " +
      "Returns the new block_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable that Claude Code sets when it spawns this MCP server. Pass explicitly only to target a different session.",
        },
        compressed_uuids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Ordered list of all message UUIDs in the range to compress. The first UUID becomes the anchor; the summary will appear at this position in the substituted request.",
        },
        summary: {
          type: "string",
          minLength: 1,
          description:
            "Summary text that will replace the anchor message's content in subsequent API requests. Author this from a landed place — it is what the model receives in place of the original messages.",
        },
        focus: {
          type: "string",
          description:
            "Optional metadata describing what the summary preserved. Stored in the registry for operator inspection; not used in substitution logic.",
        },
        original_tokens: {
          type: "integer",
          minimum: 0,
          description:
            "Approximate token count of the original messages being replaced. Stored as registry metadata.",
        },
        summary_tokens: {
          type: "integer",
          minimum: 0,
          description:
            "Approximate token count of the summary itself. Stored as registry metadata.",
        },
      },
      required: ["compressed_uuids", "summary"],
    },
  },
  {
    name: "decompress",
    description:
      "Restores a compressed block to active context. The proxy stops substituting on subsequent requests; the original messages reappear. " +
      "The block remains in the registry as inactive and can be reactivated via recompress.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable.",
        },
        block_id: {
          type: "integer",
          minimum: 1,
          description: "The block_id returned by an earlier compress call.",
        },
      },
      required: ["block_id"],
    },
  },
  {
    name: "recompress",
    description:
      "Reactivates a previously decompressed block. The proxy resumes substituting the summary for the anchor message. " +
      "The summary text is preserved byte-identical, so cache-eligible prefixes can be re-cached.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable.",
        },
        block_id: {
          type: "integer",
          minimum: 1,
          description: "The block_id to reactivate.",
        },
      },
      required: ["block_id"],
    },
  },
  {
    name: "list_compressions",
    description:
      "Lists all blocks (active and inactive) for a Claude Code session. Returns block metadata only (not the full summary text or UUID lists) to keep the response compact.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable.",
        },
      },
      required: [],
    },
  },
];

// ----------------------------------------------------------------------------
// Tool result helpers
// ----------------------------------------------------------------------------

type ToolResult = CallToolResult;

function successResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

export async function handleCompress(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  let compressedUuids: string[];
  let summary: string;
  let focus: string | undefined;
  let originalTokens: number | undefined;
  let summaryTokens: number | undefined;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
    compressedUuids = requireStringArray(a["compressed_uuids"], "compressed_uuids");
    summary = requireNonEmptyString(a["summary"], "summary");
    focus = optionalString(a["focus"], "focus");
    originalTokens = optionalNonNegativeInt(a["original_tokens"], "original_tokens");
    summaryTokens = optionalNonNegativeInt(a["summary_tokens"], "summary_tokens");
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  const blockId = await nextBlockId(sessionId);
  const anchorUuid = compressedUuids[0];
  if (anchorUuid === undefined) {
    // requireStringArray already enforces minItems >= 1, but TS narrowing
    // still wants a guard since compressed_uuids[0] is T | undefined under
    // noUncheckedIndexedAccess.
    return errorResult("compressed_uuids must contain at least one UUID");
  }

  const block: Block = {
    block_id: blockId,
    created_at: new Date().toISOString(),
    active: true,
    anchor_uuid: anchorUuid,
    compressed_uuids: compressedUuids,
    summary,
    original_tokens: originalTokens ?? 0,
    summary_tokens: summaryTokens ?? 0,
    focus: focus ?? null,
    parent_block_id: null,
  };

  await writeBlock(sessionId, block);

  return successResult({
    block_id: blockId,
    anchor_uuid: anchorUuid,
    compressed_count: compressedUuids.length,
    original_tokens: block.original_tokens,
    summary_tokens: block.summary_tokens,
    active: true,
  });
}

export async function handleDecompress(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  let blockId: number;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
    blockId = requirePositiveInt(a["block_id"], "block_id");
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  const block = await setBlockActive(sessionId, blockId, false);
  if (block === null) {
    return errorResult(
      `Block ${blockId} not found in session ${sessionId}`,
    );
  }

  return successResult({
    block_id: block.block_id,
    active: block.active,
    messages_restored: block.compressed_uuids.length,
  });
}

export async function handleRecompress(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  let blockId: number;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
    blockId = requirePositiveInt(a["block_id"], "block_id");
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  const block = await setBlockActive(sessionId, blockId, true);
  if (block === null) {
    return errorResult(
      `Block ${blockId} not found in session ${sessionId}`,
    );
  }

  return successResult({
    block_id: block.block_id,
    active: block.active,
    messages_replaced: block.compressed_uuids.length,
  });
}

export async function handleList(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  const blocks = await listBlocks(sessionId);
  return successResult({
    session_id: sessionId,
    block_count: blocks.length,
    active_count: blocks.filter((b) => b.active).length,
    blocks: blocks.map(blockToMeta),
  });
}

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

export async function dispatch(
  name: string,
  args: unknown,
): Promise<ToolResult> {
  switch (name) {
    case "compress":
      return handleCompress(args);
    case "decompress":
      return handleDecompress(args);
    case "recompress":
      return handleRecompress(args);
    case "list_compressions":
      return handleList(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
