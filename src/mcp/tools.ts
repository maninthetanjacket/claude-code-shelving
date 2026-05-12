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
  optionalNonEmptyString,
  optionalPositiveInt,
  optionalString,
  resolveSessionIdArg,
  ValidationError,
} from "./validate.js";
import { loadSessionMessages } from "../proxy/jsonl.js";
import type { JsonlMessage } from "../proxy/transform.js";

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
      "Returns the new block_id. Can specify range either by compressed_uuids array, phrase matching (first_phrase + optional last_phrase), or turn numbers (start_turn + optional end_turn). " +
      "When using phrase matching, returns preview info (turns, tokens) before compression unless confirm=true is passed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise the server falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR. Pass explicitly only to target a different session.",
        },
        compressed_uuids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Ordered list of all message UUIDs in the range to compress. The first UUID becomes the anchor; the summary will appear at this position in the substituted request. Use this OR phrase-based selection (first_phrase) OR turn numbers (start_turn).",
        },
        start_turn: {
          type: "integer",
          minimum: 1,
          description: "The starting turn number of the range to compress (1-indexed). Use this OR compressed_uuids OR first_phrase.",
        },
        end_turn: {
          type: "integer",
          minimum: 1,
          description: "The ending turn number of the range to compress (1-indexed). Optional; defaults to the latest user message if omitted when using start_turn.",
        },
        first_phrase: {
          type: "string",
          description:
            "Text phrase to find the start of the range. Matches substrings in message content. Use with optional last_phrase to define a range, or alone to compress from first match to the most recent user message. Use this OR compressed_uuids.",
        },
        last_phrase: {
          type: "string",
          description:
            "Optional text phrase to find the end of the range. If provided, compresses from first_phrase match through last_phrase match. If omitted with first_phrase, compresses from first_phrase to the latest user message.",
        },
        summary: {
          type: "string",
          minLength: 1,
          description:
            "Summary text that will replace the anchor message's content in subsequent API requests. Author this from a landed place — it is what the model receives in place of the original messages. Required unless preview_only=true.",
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
        preview_only: {
          type: "boolean",
          description:
            "If true, only return preview info (turns, tokens, matched phrases) without performing compression. Default false.",
        },
        confirm: {
          type: "boolean",
          description:
            "If true, skip preview and proceed directly to compression. Required when using phrase-based selection with preview_only=false.",
        },
      },
      required: [],
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
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR.",
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
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR.",
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
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR.",
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
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR.",
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
            "Claude Code session UUID. Optional: defaults to CLAUDE_CODE_SESSION_ID when available; otherwise falls back to the most recently modified session transcript for CLAUDE_PROJECT_DIR.",
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
  let compressedUuids: string[] | undefined;
  let startTurn: number | undefined;
  let endTurn: number | undefined;
  let firstPhrase: string | undefined;
  let lastPhrase: string | undefined;
  let summary: string | undefined;
  let focus: string | undefined;
  let originalTokens: number | undefined;
  let summaryTokens: number | undefined;
  let previewOnly: boolean;
  let confirm: boolean;
  try {
    sessionId = await resolveSessionIdArg(a["session_id"]);
    compressedUuids = optionalStringArray(a["compressed_uuids"], "compressed_uuids");
    startTurn = optionalPositiveInt(a["start_turn"], "start_turn");
    endTurn = optionalPositiveInt(a["end_turn"], "end_turn");
    firstPhrase = optionalNonEmptyString(a["first_phrase"], "first_phrase");
    lastPhrase = optionalNonEmptyString(a["last_phrase"], "last_phrase");
    summary = optionalString(a["summary"], "summary");
    focus = optionalString(a["focus"], "focus");
    originalTokens = optionalNonNegativeInt(a["original_tokens"], "original_tokens");
    summaryTokens = optionalNonNegativeInt(a["summary_tokens"], "summary_tokens");
    previewOnly = optionalBoolean(a["preview_only"], "preview_only") ?? false;
    confirm = optionalBoolean(a["confirm"], "confirm") ?? false;
  } catch (e) {
    if (e instanceof ValidationError) return errorResult(e.message);
    throw e;
  }

  // Validate argument combinations
  const hasUuids = compressedUuids !== undefined && compressedUuids.length > 0;
  const hasPhrase = firstPhrase !== undefined;
  const hasTurns = startTurn !== undefined;

  if (!hasUuids && !hasPhrase && !hasTurns) {
    return errorResult(
      "Must provide either compressed_uuids array, first_phrase, or start_turn for range selection"
    );
  }
  if ((hasUuids && hasPhrase) || (hasUuids && hasTurns) || (hasPhrase && hasTurns)) {
    return errorResult(
      "Cannot specify multiple range selection methods; choose either compressed_uuids, phrase matching, or turn numbers"
    );
  }

  // Load session messages for phrase matching or preview
  const { path, messages } = await loadSessionMessages(sessionId);
  if (path === null) {
    return errorResult(`Session JSONL not found for session ${sessionId}`);
  }

  let rangeUuids: string[];
  let startMatch: string | null;
  let endMatch: string | null;
  let estimatedTokens: number;

  if (hasTurns) {
    // Turn-based range selection (1-indexed, based on collapsed UUID stream)
    const collapsedUuids = collapseConsecutiveDuplicates(messages.map((m) => m.uuid));
    const sIdx = startTurn! - 1;
    let eIdx = -1;

    if (endTurn !== undefined) {
      eIdx = endTurn - 1;
    } else {
      // Default to the most recent user message in the session
      for (let i = messages.length - 1; i >= sIdx; i--) {
        const msg = messages[i];
        if (msg && msg.role === "user") {
          const uuid = msg.uuid;
          // Find the last occurrence of this UUID in the collapsed stream
          for (let j = collapsedUuids.length - 1; j >= sIdx; j--) {
            if (collapsedUuids[j] === uuid) {
              eIdx = j;
              break;
            }
          }
          if (eIdx !== -1) break;
        }
      }
      if (eIdx === -1) eIdx = collapsedUuids.length - 1;
    }

    if (sIdx < 0 || sIdx >= collapsedUuids.length) {
      return errorResult(`start_turn ${startTurn} is out of bounds (1-${collapsedUuids.length})`);
    }
    if (eIdx < sIdx || eIdx >= collapsedUuids.length) {
      return errorResult(`end_turn ${endTurn ?? "latest user message"} is out of bounds or before start_turn`);
    }

    rangeUuids = collapsedUuids.slice(sIdx, eIdx + 1);
    startMatch = `Turn ${sIdx + 1}`;
    endMatch = `Turn ${eIdx + 1}`;

    const startUuid = collapsedUuids[sIdx];
    const endUuid = collapsedUuids[eIdx];
    const firstMsgIdx = messages.findIndex((m) => m.uuid === startUuid);
    const lastMsgIdx = messages.findLastIndex((m: JsonlMessage) => m.uuid === endUuid);

    estimatedTokens = estimateTokensForMessageIndexRange(
      messages,
      firstMsgIdx,
      lastMsgIdx,
    );

    if (previewOnly) {
      const startUuid = rangeUuids[0];
      const endUuid = rangeUuids[rangeUuids.length - 1];
      const anchorSnippet =
        startUuid !== undefined
          ? previewSnippetForUuid(messages, startUuid, "start of selected range")
          : "start of selected range";
      const endSnippet =
        endUuid !== undefined
          ? previewSnippetForUuid(messages, endUuid, "end of selected range")
          : "end of selected range";

      return successResult({
        preview: true,
        session_id: sessionId,
        start_turn: sIdx + 1,
        end_turn: eIdx + 1,
        start_match: `Turn ${sIdx + 1}`,
        anchor_snippet: anchorSnippet,
        end_match: `Turn ${eIdx + 1}`,
        end_snippet: endSnippet,
        turns: rangeUuids.length,
        estimated_tokens: estimatedTokens,
        range_uuids: rangeUuids,
        note: "Set preview_only=false with summary to perform compression",
      });
    }
  } else if (hasPhrase) {
    // Phrase-based range selection
    if (!confirm && !previewOnly) {
      return errorResult(
        "Phrase-based selection requires confirm=true to proceed, or set preview_only=true to preview first"
      );
    }
    const result = findRangeByPhrase(messages, firstPhrase!, lastPhrase);
    if ("error" in result) {
      return errorResult(result.error);
    }
    rangeUuids = result.uuids;
    startMatch = result.startMatch;
    endMatch = result.endMatch;
    estimatedTokens = result.estimatedTokens;

    // Return preview if requested
    if (previewOnly) {
      return successResult({
        preview: true,
        session_id: sessionId,
        start_phrase: firstPhrase,
        start_turn: result.startTurn,
        end_turn: result.endTurn,
        start_match: startMatch,
        anchor_snippet: result.anchorSnippet,
        end_phrase: lastPhrase ?? "latest user message",
        end_match: endMatch,
        end_snippet: result.endSnippet,
        turns: rangeUuids.length,
        estimated_tokens: estimatedTokens,
        range_uuids: rangeUuids,
        note: "Pass confirm=true with summary to perform compression",
      });
    }
  } else {
    // UUID-based range selection (original behavior)
    if (compressedUuids!.length === 0) {
      return errorResult("compressed_uuids must contain at least one UUID");
    }
    const validationError = await validateCompressedRange(sessionId, compressedUuids!);
    if (validationError !== null) {
      return errorResult(validationError);
    }
    rangeUuids = compressedUuids!;
    const firstUuid = compressedUuids![0];
    const lastUuid = compressedUuids![compressedUuids!.length - 1];
    estimatedTokens =
      firstUuid !== undefined && lastUuid !== undefined
        ? estimateTokensForUuidRange(messages, firstUuid, lastUuid)
        : 0;
    startMatch = null;
    endMatch = null;
  }

  // Require summary for actual compression
  if (summary === undefined || summary.trim().length === 0) {
    return errorResult("summary is required for compression");
  }

  const blockId = await nextBlockId(sessionId);
  const anchorUuid = rangeUuids[0];
  if (anchorUuid === undefined) {
    return errorResult("range produced an empty UUID list");
  }

  const block: Block = {
    block_id: blockId,
    created_at: new Date().toISOString(),
    active: true,
    anchor_uuid: anchorUuid,
    compressed_uuids: rangeUuids,
    summary,
    original_tokens: originalTokens ?? estimatedTokens,
    summary_tokens: summaryTokens ?? 0,
    focus: focus ?? null,
    parent_block_id: null,
  };

  await writeBlock(sessionId, block);

  return successResult({
    block_id: blockId,
    anchor_uuid: anchorUuid,
    compressed_count: rangeUuids.length,
    original_tokens: block.original_tokens,
    summary_tokens: block.summary_tokens,
    active: true,
  });
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringArray(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean if provided`);
  }
  return value;
}

function findRangeByPhrase(
  messages: JsonlMessage[],
  firstPhrase: string,
  lastPhrase: string | undefined,
):
  | {
      uuids: string[];
      startMatch: string;
      endMatch: string;
      startTurn: number;
      endTurn: number;
      anchorSnippet: string;
      endSnippet: string;
      estimatedTokens: number;
    }
  | { error: string } {
  // Find first occurrence of firstPhrase (case-insensitive substring match)
  const lowerFirst = firstPhrase.toLowerCase();
  let startIndex = -1;
  let startMatch = "";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    const content = messageContentToString(msg.content);
    if (content.toLowerCase().includes(lowerFirst)) {
      startIndex = i;
      startMatch = previewSnippet(content);
      break;
    }
  }

  if (startIndex === -1) {
    return { error: `Could not find first phrase "${firstPhrase}" in any message content` };
  }

  // Determine end index
  let endIndex = startIndex;
  if (lastPhrase !== undefined) {
    // Find first occurrence of lastPhrase at or after startIndex
    const lowerLast = lastPhrase.toLowerCase();
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (msg === undefined) continue;
      const content = messageContentToString(msg.content);
      if (content.toLowerCase().includes(lowerLast)) {
        endIndex = i;
        break;
      }
    }
    const startMsg = messages[startIndex];
    if (endIndex === startIndex && startMsg !== undefined) {
      const startContent = messageContentToString(startMsg.content);
      if (!startContent.toLowerCase().includes(lowerLast)) {
        return { error: `Could not find last phrase "${lastPhrase}" in messages after first match` };
      }
    }
  } else {
    // Find the most recent user message
    for (let i = messages.length - 1; i >= startIndex; i--) {
      const msg = messages[i];
      if (msg === undefined) continue;
      if (msg.role === "user") {
        endIndex = i;
        break;
      }
    }
  }

  const startMsg = messages[startIndex];
  const endMsg = messages[endIndex];
  if (startMsg === undefined || endMsg === undefined) {
    return { error: "Could not resolve messages at matched positions" };
  }

  // Collect UUIDs in the range, collapsing consecutive duplicates
  const expandedUuidStream = collapseConsecutiveDuplicates(
    messages.map((m) => m.uuid)
  );

  // Find positions in the collapsed stream
  const startUuid = startMsg.uuid;
  const endUuid = endMsg.uuid;

  const startPos = expandedUuidStream.indexOf(startUuid);
  let endPos = -1;
  for (let i = expandedUuidStream.length - 1; i >= 0; i--) {
    if (expandedUuidStream[i] === endUuid) {
      endPos = i;
      break;
    }
  }

  if (startPos === -1 || endPos === -1 || startPos > endPos) {
    return { error: "Could not resolve contiguous range from phrase matches" };
  }

  const uuids = expandedUuidStream.slice(startPos, endPos + 1);

  const estimatedTokens = estimateTokensForUuidRange(messages, startUuid, endUuid);

  const endContent = messageContentToString(endMsg.content);

  return {
    uuids,
    startMatch,
    endMatch: previewSnippet(endContent),
    startTurn: startPos + 1,
    endTurn: endPos + 1,
    anchorSnippet: previewSnippet(messageContentToString(startMsg.content)),
    endSnippet: previewSnippet(endContent),
    estimatedTokens,
  };
}

function previewSnippet(content: string): string {
  return content.substring(0, 100) + (content.length > 100 ? "..." : "");
}

function previewSnippetForUuid(
  messages: JsonlMessage[],
  uuid: string,
  fallback: string,
): string {
  const msg = messages.find((candidate) => candidate.uuid === uuid);
  return msg ? previewSnippet(messageContentToString(msg.content)) : fallback;
}

function estimateTokensForUuidRange(
  messages: JsonlMessage[],
  startUuid: string,
  endUuid: string,
): number {
  const firstMsgIdx = messages.findIndex((m) => m.uuid === startUuid);
  const lastMsgIdx = messages.findLastIndex((m: JsonlMessage) => m.uuid === endUuid);
  return estimateTokensForMessageIndexRange(messages, firstMsgIdx, lastMsgIdx);
}

function estimateTokensForMessageIndexRange(
  messages: JsonlMessage[],
  firstMsgIdx: number,
  lastMsgIdx: number,
): number {
  if (firstMsgIdx === -1 || lastMsgIdx === -1 || firstMsgIdx > lastMsgIdx) {
    return 0;
  }

  let charCount = 0;
  for (let i = firstMsgIdx; i <= lastMsgIdx; i++) {
    const msg = messages[i];
    charCount += msg ? messageContentToString(msg.content).length : 0;
  }

  return Math.ceil(charCount / 4);
}

function messageContentToString(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(contentBlockToString)
      .filter((item) => item.length > 0)
      .join("\n");
  }
  return "";
}

function contentBlockToString(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const block = item as Record<string, unknown>;
  if (typeof block["text"] === "string") {
    return block["text"];
  }

  if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
    return block["thinking"];
  }

  if (block["type"] === "tool_use") {
    const parts: string[] = [];
    if (typeof block["name"] === "string") parts.push(block["name"]);
    if (block["input"] !== undefined) parts.push(stableStringify(block["input"]));
    return parts.join("\n");
  }

  if (block["type"] === "tool_result") {
    const content = block["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(contentBlockToString)
        .filter((part) => part.length > 0)
        .join("\n");
    }
    if (content && typeof content === "object") {
      return contentBlockToString(content);
    }
    return "";
  }

  return "";
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
    sessionId = await resolveSessionIdArg(a["session_id"]);
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
    sessionId = await resolveSessionIdArg(a["session_id"]);
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
    sessionId = await resolveSessionIdArg(a["session_id"]);
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
    sessionId = await resolveSessionIdArg(a["session_id"]);
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
    sessionId = await resolveSessionIdArg(a["session_id"]);
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
  const estimatedTokens = estimateTokensForUuidRange(
    messages,
    bookmark.anchor_uuid,
    endUuid,
  );

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
    original_tokens: originalTokens ?? estimatedTokens,
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
