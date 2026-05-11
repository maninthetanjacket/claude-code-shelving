import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  listBlocks,
  nextBlockId,
  setBlockActive,
  writeBlock,
} from "../shared/registry.js";
import {
  deleteBookmark,
  getBookmark,
  setBookmark,
} from "../shared/bookmarks.js";
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
import { loadSessionMessages } from "../proxy/jsonl.js";

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
  {
    name: "start_arc",
    description:
      "Records a labeled bookmark at the current point in the session. The bookmark captures the UUID of the most recent JSONL entry at invocation time (typically the user message that triggered this assistant turn). Pair with compress_arc to later compress everything from this point through the most recent user message into a single summary, without having to enumerate UUIDs by hand.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable.",
        },
        label: {
          type: "string",
          minLength: 1,
          description:
            "Label for this bookmark, unique within the session. Used later by compress_arc to identify the range. If a bookmark with this label already exists, it is replaced.",
        },
      },
      required: ["label"],
    },
  },
  {
    name: "compress_arc",
    description:
      "Compresses the range of messages from a previously-set bookmark to the most recent user message in the session. The bookmark's anchor UUID becomes the start; the latest user message at this call becomes the end. The current assistant turn (containing any preceding reflection text and the compress_arc call itself) is naturally excluded, leaving the reflection visible in the conversation. Equivalent to looking up the UUIDs and calling compress directly, but mechanical. The bookmark is removed once the compression succeeds.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to the CLAUDE_CODE_SESSION_ID environment variable.",
        },
        label: {
          type: "string",
          minLength: 1,
          description:
            "Label of the bookmark set earlier via start_arc. Identifies which arc to compress.",
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
      required: ["label", "summary"],
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

  const validationError = await validateCompressedRange(sessionId, compressedUuids);
  if (validationError !== null) {
    return errorResult(validationError);
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

async function validateCompressedRange(
  sessionId: string,
  compressedUuids: string[],
): Promise<string | null> {
  const { path, messages } = await loadSessionMessages(sessionId);
  if (path === null) {
    return `Session JSONL not found for session ${sessionId}`;
  }

  const expandedUuidStream = collapseConsecutiveDuplicates(
    messages.map((message) => message.uuid),
  );
  const uuidToIndex = new Map<string, number>();
  for (let i = 0; i < expandedUuidStream.length; i++) {
    const uuid = expandedUuidStream[i];
    if (uuid !== undefined && !uuidToIndex.has(uuid)) {
      uuidToIndex.set(uuid, i);
    }
  }

  const seen = new Set<string>();
  for (const uuid of compressedUuids) {
    if (seen.has(uuid)) {
      return `compressed_uuids contains duplicate UUID ${uuid}`;
    }
    seen.add(uuid);
    if (!uuidToIndex.has(uuid)) {
      return `compressed_uuids contains UUID ${uuid} that was not found in session ${sessionId}`;
    }
  }

  const firstUuid = compressedUuids[0];
  const lastUuid = compressedUuids[compressedUuids.length - 1];
  if (firstUuid === undefined || lastUuid === undefined) {
    return "compressed_uuids must contain at least one UUID";
  }
  const start = uuidToIndex.get(firstUuid);
  const end = uuidToIndex.get(lastUuid);
  if (start === undefined || end === undefined) {
    return "compressed_uuids could not be aligned to the session JSONL";
  }
  if (start > end) {
    return "compressed_uuids must be ordered chronologically";
  }

  const expectedRange = expandedUuidStream.slice(start, end + 1);
  if (expectedRange.length !== compressedUuids.length) {
    return (
      "compressed_uuids must describe a contiguous range in the session JSONL " +
      `(expected ${JSON.stringify(expectedRange)})`
    );
  }
  for (let i = 0; i < compressedUuids.length; i++) {
    if (compressedUuids[i] !== expectedRange[i]) {
      return (
        "compressed_uuids must describe a contiguous range in the session JSONL " +
        `(expected ${JSON.stringify(expectedRange)})`
      );
    }
  }

  return null;
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
// Bookmark handlers (start_arc / compress_arc)
// ----------------------------------------------------------------------------

export async function handleStartArc(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  let label: string;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
    label = requireNonEmptyString(a["label"], "label");
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  // Find the most recent JSONL entry; its UUID is the bookmark anchor.
  // At start_arc invocation time, the current assistant turn (containing
  // start_arc itself) has not yet been written to JSONL, so the latest
  // entry is the user message that triggered this turn.
  const { path, messages } = await loadSessionMessages(sessionId);
  if (path === null) {
    return errorResult(`Session JSONL not found for session ${sessionId}`);
  }
  if (messages.length === 0) {
    return errorResult(
      `Session JSONL for ${sessionId} contains no messages to anchor at`,
    );
  }

  const latest = messages[messages.length - 1];
  if (latest === undefined) {
    return errorResult("could not resolve the latest JSONL entry");
  }

  const bookmark = {
    label,
    anchor_uuid: latest.uuid,
    created_at: new Date().toISOString(),
  };
  await setBookmark(sessionId, bookmark);

  return successResult({
    label: bookmark.label,
    anchor_uuid: bookmark.anchor_uuid,
    created_at: bookmark.created_at,
  });
}

export async function handleCompressArc(args: unknown): Promise<ToolResult> {
  if (typeof args !== "object" || args === null) {
    return errorResult("arguments must be an object");
  }
  const a = args as Record<string, unknown>;

  let sessionId: string;
  let label: string;
  let summary: string;
  let focus: string | undefined;
  let originalTokens: number | undefined;
  let summaryTokens: number | undefined;
  try {
    sessionId = resolveSessionIdArg(a["session_id"]);
    label = requireNonEmptyString(a["label"], "label");
    summary = requireNonEmptyString(a["summary"], "summary");
    focus = optionalString(a["focus"], "focus");
    originalTokens = optionalNonNegativeInt(a["original_tokens"], "original_tokens");
    summaryTokens = optionalNonNegativeInt(a["summary_tokens"], "summary_tokens");
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  const bookmark = await getBookmark(sessionId, label);
  if (bookmark === null) {
    return errorResult(
      `No bookmark labeled "${label}" found in session ${sessionId}. ` +
        `Call start_arc first.`,
    );
  }

  const { path, messages } = await loadSessionMessages(sessionId);
  if (path === null) {
    return errorResult(`Session JSONL not found for session ${sessionId}`);
  }

  // Find the bookmark's anchor in the JSONL.
  const anchorIdx = messages.findIndex((m) => m.uuid === bookmark.anchor_uuid);
  if (anchorIdx === -1) {
    return errorResult(
      `Bookmark "${label}" points at UUID ${bookmark.anchor_uuid}, ` +
        `which was not found in the session JSONL.`,
    );
  }

  // End of range: the most recent user message in the JSONL at this moment.
  // This naturally excludes the current assistant turn (the one containing
  // this compress_arc call and any preceding reflection text), since that
  // turn has not yet been written to JSONL.
  let endIdx = -1;
  for (let i = messages.length - 1; i >= anchorIdx; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "user") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return errorResult(
      `Bookmark "${label}" has no user message after the anchor to close the range. ` +
        `Run some work that produces tool_results before calling compress_arc.`,
    );
  }

  // Collect the contiguous UUID range. Use the same collapse-consecutive
  // semantics as the existing validation logic to handle any sidechain
  // duplication in the JSONL.
  const expandedUuidStream = collapseConsecutiveDuplicates(
    messages.map((m) => m.uuid),
  );
  // Find anchor/end positions in the collapsed stream by their UUIDs.
  const anchorPos = expandedUuidStream.indexOf(bookmark.anchor_uuid);
  const endUuid = messages[endIdx]?.uuid;
  if (endUuid === undefined) {
    return errorResult("could not resolve end UUID for the bookmarked range");
  }
  // Find the LAST occurrence of endUuid in the collapsed stream to be safe.
  let endPos = -1;
  for (let i = expandedUuidStream.length - 1; i >= 0; i--) {
    if (expandedUuidStream[i] === endUuid) {
      endPos = i;
      break;
    }
  }
  if (anchorPos === -1 || endPos === -1 || anchorPos > endPos) {
    return errorResult(
      "could not assemble a contiguous range from bookmark anchor to latest user message",
    );
  }
  const compressedUuids = expandedUuidStream.slice(anchorPos, endPos + 1);

  // Build and persist the block (same shape as handleCompress).
  const blockId = await nextBlockId(sessionId);
  const anchorUuid = compressedUuids[0];
  if (anchorUuid === undefined) {
    return errorResult("bookmark range produced an empty UUID list");
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

  // Remove the bookmark — its purpose is fulfilled. A future start_arc
  // with the same label is then unambiguous.
  await deleteBookmark(sessionId, label);

  return successResult({
    block_id: blockId,
    label,
    anchor_uuid: anchorUuid,
    compressed_count: compressedUuids.length,
    original_tokens: block.original_tokens,
    summary_tokens: block.summary_tokens,
    active: true,
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
    case "start_arc":
      return handleStartArc(args);
    case "compress_arc":
      return handleCompressArc(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
