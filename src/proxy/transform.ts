import type { Block } from "../shared/types.js";

/**
 * Pure transformation logic for the proxy.
 *
 * Input: an Anthropic Messages API request body (parsed JSON), a UUID→content
 * map derived from the session JSONL, and the list of active blocks for the
 * session.
 *
 * Output: a modified request body where each compressed range has been
 * collapsed to its summary at the anchor position.
 *
 * Matching strategy: content-based, at two granularities.
 *
 * Whole-message: each request message is normalized and compared against the
 * UUID→content map. If a whole message matches, we know its UUID and can
 * check membership in active blocks.
 *
 * Fragment-level: when whole-message matching fails (because CC has combined
 * multiple JSONL entries into one API message — e.g., thinking + text +
 * tool_use), each content block is matched individually via
 * `fragmentKeyForBlock`. This recovers the UUIDs of constituent fragments
 * even when their containing message has no exact equivalent in JSONL.
 *
 * Anchor-seen filter: before substituting, we verify that the block's anchor
 * UUID was matched somewhere in this request. Without this, a request that
 * contains only drop-targets (no anchor) could lose them with nothing to
 * substitute at the anchor position. The filter ensures all-or-nothing
 * application per block per request.
 *
 * Fragment substitution: when an anchor is a fragment inside a larger
 * assistant message (typical case: tool_use embedded with thinking and
 * text), `rewriteEmbeddedAnchorContent` substitutes just that fragment in
 * place. Surrounding thinking and text are preserved.
 *
 * Both sides go through `normalizeContent` before matching. See the comment
 * on that function for the canonicalization invariants — the matcher is
 * "same logical message," not "same bytes."
 *
 * Cache stability: this function is deterministic given the same inputs.
 * Same registry + same JSONL state = same output bytes.
 */

/**
 * A single message in the Anthropic Messages API request.
 * `content` may be a plain string or an array of content blocks
 * (text, tool_use, tool_result, image, etc).
 */
export interface ApiMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface ApiRequest {
  messages: ApiMessage[];
  // Other fields (model, system, tools, etc.) pass through unchanged.
  [key: string]: unknown;
}

/** A message from the session JSONL, simplified to what we need. */
export interface JsonlMessage {
  uuid: string;
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface TransformResult {
  request: ApiRequest;
  /** Number of API messages substituted with a summary (anchor positions). */
  anchors_substituted: number;
  /** Number of API messages dropped entirely (non-anchor compressed messages). */
  messages_dropped: number;
  /** Active blocks that had any matched message in this request. */
  blocks_applied: number[];
  /** Active blocks that had no matched messages (likely older than current request scope). */
  blocks_inactive_in_request: number[];
}

/**
 * Apply registered substitutions to an API request.
 *
 * Algorithm:
 *  1. Build a content-key index over the JSONL: `key(content) → uuid`
 *  2. For each active block, look up the content of every UUID in
 *     `block.compressed_uuids` to build the set of content-keys to match.
 *  3. Walk the request's messages array. For each message:
 *     - Compute its content-key.
 *     - If the key matches a UUID in some active block:
 *       - If that UUID is the block's anchor: replace content with the
 *         block's summary.
 *       - Else: mark the message for drop.
 *     - Else: pass through.
 *  4. Return the messages array with drops removed and anchors substituted.
 *
 * Failure modes (all fail-safe to no-op for affected messages, leaving the
 * passthrough version reaching the API):
 *  - JSONL doesn't contain a UUID listed in a block: that UUID's
 *    content-key is unknown, so its message in the request won't match;
 *    the request message passes through. The block is still considered
 *    "applied" if any of its UUIDs did match.
 *  - Two different UUIDs have identical content (e.g., a repeated empty
 *    string): the second one would match the first one's block. Practically
 *    rare in real conversations; we accept the risk for v1.
 */
export function applySubstitutions(
  request: ApiRequest,
  jsonlMessages: JsonlMessage[],
  activeBlocks: Block[],
): TransformResult {
  if (activeBlocks.length === 0) {
    return {
      request,
      anchors_substituted: 0,
      messages_dropped: 0,
      blocks_applied: [],
      blocks_inactive_in_request: [],
    };
  }

  // Build exact content-key → uuid map from the JSONL, plus a fragment index
  // for cases where CC combines multiple logical messages into one API message
  // or adds transport-only blocks like assistant thinking.
  // If two UUIDs share a content-key, last one wins (rare; documented).
  const keyToUuid = new Map<string, string>();
  const fragmentKeyToUuids = new Map<string, string[]>();
  for (const m of jsonlMessages) {
    keyToUuid.set(contentKey(m.role, m.content), m.uuid);
    for (const fragmentKey of fragmentKeys(m.role, m.content)) {
      const existing = fragmentKeyToUuids.get(fragmentKey);
      if (existing === undefined) {
        fragmentKeyToUuids.set(fragmentKey, [m.uuid]);
      } else if (!existing.includes(m.uuid)) {
        existing.push(m.uuid);
      }
    }
  }

  // Build uuid → block lookup for each active block, plus uuid → role-in-block.
  // role_in_block: "anchor" or "drop".
  type Role = "anchor" | "drop";
  const uuidToBlock = new Map<string, { block: Block; role: Role }>();
  for (const block of activeBlocks) {
    for (let i = 0; i < block.compressed_uuids.length; i++) {
      const uuid = block.compressed_uuids[i];
      if (uuid === undefined) continue;
      const role: Role = uuid === block.anchor_uuid ? "anchor" : "drop";
      uuidToBlock.set(uuid, { block, role });
    }
  }

  const newMessages: ApiMessage[] = [];
  const blocksApplied = new Set<number>();
  const anchorSeenByBlockId = new Set<number>();
  let anchorsSubstituted = 0;
  let messagesDropped = 0;

  const resolvedPerMessage = request.messages.map((apiMsg) =>
    resolveMessageMatch(apiMsg, keyToUuid, fragmentKeyToUuids),
  );

  for (const resolved of resolvedPerMessage) {
    for (const uuid of resolved.matchedUuids) {
      const hit = uuidToBlock.get(uuid);
      if (hit?.role === "anchor") {
        anchorSeenByBlockId.add(hit.block.block_id);
      }
    }
  }

  for (let idx = 0; idx < request.messages.length; idx++) {
    const apiMsg = request.messages[idx];
    if (apiMsg === undefined) continue;
    const resolved = resolvedPerMessage[idx];
    const matchedUuids = resolved?.matchedUuids ?? [];
    if (matchedUuids.length === 0) {
      // Not found in JSONL (could be a system-injected message or content
      // that CC transformed before sending). Pass through.
      newMessages.push(apiMsg);
      continue;
    }

    const blockHits = matchedUuids
      .map((uuid) => ({ uuid, hit: uuidToBlock.get(uuid) }))
      .filter(
        (entry): entry is { uuid: string; hit: { block: Block; role: Role } } =>
          entry.hit !== undefined && anchorSeenByBlockId.has(entry.hit.block.block_id),
      );

    if (blockHits.length === 0) {
      // UUID exists in JSONL but not in any active block. Pass through.
      newMessages.push(apiMsg);
      continue;
    }

    const blockIds = new Set(blockHits.map((entry) => entry.hit.block.block_id));
    if (blockIds.size > 1) {
      // Ambiguous: this API message appears to contain content from multiple
      // blocks. Fail safe to passthrough rather than risking a wrong rewrite.
      newMessages.push(apiMsg);
      continue;
    }

    const blockHit = blockHits[0];
    if (blockHit === undefined) {
      newMessages.push(apiMsg);
      continue;
    }

    const block = blockHit.hit.block;
    const containsAnchor = blockHits.some((entry) => entry.hit.role === "anchor");

    blocksApplied.add(block.block_id);
    if (containsAnchor) {
      const rewrittenContent = rewriteEmbeddedAnchorContent(
        apiMsg,
        block,
        resolved,
        uuidToBlock,
      );
      // Substitute content with the block's summary.
      // Use a single user-role text message containing the summary, prefixed
      // with a marker so the model can recognize the substitution.
      newMessages.push({
        role: apiMsg.role,
        content: rewrittenContent ?? formatSummaryContent(block, apiMsg.content),
      });
      anchorsSubstituted++;
    } else {
      // Drop this message entirely.
      messagesDropped++;
    }
  }

  const blocksAppliedList = Array.from(blocksApplied).sort((a, b) => a - b);
  const blocksInactive = activeBlocks
    .map((b) => b.block_id)
    .filter((id) => !blocksApplied.has(id))
    .sort((a, b) => a - b);

  return {
    request: { ...request, messages: newMessages },
    anchors_substituted: anchorsSubstituted,
    messages_dropped: messagesDropped,
    blocks_applied: blocksAppliedList,
    blocks_inactive_in_request: blocksInactive,
  };
}

/**
 * Produce a content-key for a (role, content) pair.
 *
 * Stringifies content deterministically. For string content, the key is just
 * `<role>:<content>`. For array content, JSON-serialize with a stable key
 * order (which `JSON.stringify` provides for object keys in insertion order;
 * we don't depend on key reordering here).
 */
function contentKey(role: string, content: string | unknown[]): string {
  const normalized = normalizeContent(content);
  if (typeof normalized === "string") {
    return `${role}:s:${normalized}`;
  }
  return `${role}:a:${JSON.stringify(normalized)}`;
}

function fragmentKeys(role: string, content: string | unknown[]): string[] {
  const normalized = normalizeContent(content);
  if (typeof normalized === "string") {
    return [`${role}:f:${normalized}`];
  }
  const keys: string[] = [];
  for (const block of normalized) {
    const key = fragmentKeyForBlock(role, block);
    if (key !== null) keys.push(key);
  }
  return keys;
}

interface ResolvedMessageMatch {
  matchedUuids: string[];
  exactUuid: string | null;
  fragmentMatches: string[][];
}

function resolveMessageMatch(
  message: ApiMessage,
  keyToUuid: Map<string, string>,
  fragmentKeyToUuids: Map<string, string[]>,
): ResolvedMessageMatch {
  const exact = keyToUuid.get(contentKey(message.role, message.content));
  if (exact !== undefined) {
    return {
      matchedUuids: [exact],
      exactUuid: exact,
      fragmentMatches: Array.isArray(message.content)
        ? message.content.map(() => [])
        : [],
    };
  }

  if (!Array.isArray(message.content)) {
    return { matchedUuids: [], exactUuid: null, fragmentMatches: [] };
  }

  const matched = new Set<string>();
  const fragmentMatches = message.content.map((block) => {
    const key = fragmentKeyForBlock(message.role, block);
    if (key === null) return [];
    const uuids = fragmentKeyToUuids.get(key) ?? [];
    for (const uuid of uuids) matched.add(uuid);
    return uuids;
  });
  return {
    matchedUuids: Array.from(matched),
    exactUuid: null,
    fragmentMatches,
  };
}

function fragmentKeyForBlock(role: string, block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const record = block as Record<string, unknown>;
  if (record["type"] === "text") {
    const text = record["text"];
    if (typeof text !== "string") return null;
    return `${role}:f:${trimSingleTrailingNewline(text)}`;
  }
  if (record["type"] === "tool_use") {
    return `${role}:f:${JSON.stringify(normalizeToolUseBlock(record))}`;
  }
  if (record["type"] === "tool_result") {
    return `${role}:f:${JSON.stringify(normalizeToolResultBlock(record))}`;
  }
  return null;
}

function rewriteEmbeddedAnchorContent(
  message: ApiMessage,
  block: Block,
  resolved: ResolvedMessageMatch | undefined,
  uuidToBlock: Map<string, { block: Block; role: "anchor" | "drop" }>,
): string | unknown[] | null {
  if (
    resolved === undefined ||
    resolved.exactUuid !== null ||
    !Array.isArray(message.content)
  ) {
    return null;
  }

  let replacedAnchor = false;
  let touched = false;
  const rewritten: unknown[] = [];

  for (let i = 0; i < message.content.length; i++) {
    const originalBlock = message.content[i];
    const matchedUuids = resolved.fragmentMatches[i] ?? [];
    const hits = matchedUuids
      .map((uuid) => uuidToBlock.get(uuid))
      .filter(
        (hit): hit is { block: Block; role: "anchor" | "drop" } =>
          hit !== undefined && hit.block.block_id === block.block_id,
      );

    if (hits.length === 0) {
      rewritten.push(originalBlock);
      continue;
    }

    touched = true;
    if (hits.some((hit) => hit.role === "anchor")) {
      if (!replacedAnchor) {
        rewritten.push({
          type: "text",
          text: formatSummaryContent(block, message.content),
        });
        replacedAnchor = true;
      }
      continue;
    }

    // Drop-only fragment from this block: omit it.
  }

  if (!touched || !replacedAnchor) {
    return null;
  }
  return rewritten;
}

/**
 * Canonicalize a message's content for matching.
 *
 * The matcher's invariant is **same logical message, not same bytes**. JSONL
 * and the live API request body represent the same conceptual content with
 * small structural differences — different layers add or strip metadata that
 * doesn't change meaning. This function removes those differences so equal
 * messages compare equal.
 *
 * Each rule below is here because a real bug surfaced from drift between the
 * two representations. New rules should follow the same pattern: add the
 * rule, document the symptom that motivated it, and add a regression test in
 * `tests/transform.test.ts`.
 *
 * Rules currently applied:
 *
 * 1. **Drop `thinking` blocks.** The API request body may contain assistant
 *    reasoning/thinking content blocks that aren't persisted in JSONL. They
 *    aren't part of the logical message exchange — they're transport-layer
 *    metadata for the model's chain-of-thought.
 *    Symptom: assistant messages with thinking failed to match their
 *    JSONL counterparts because the request had blocks JSONL didn't.
 *
 * 2. **Trim a single trailing newline** on raw text content and on `text`
 *    blocks. Some encoding paths add a terminal newline; comparing them
 *    byte-equal would falsely diverge.
 *    Symptom: matches missed by a single trailing `\n`.
 *
 * 3. **Strip harness-injected `<system-reminder>` from `tool_result.content`.**
 *    When CC observes a side effect (e.g., a file edit) it may append a
 *    `\n\n<system-reminder>...</system-reminder>` to the next user
 *    `tool_result` it sends to the API. JSONL records only the bare tool
 *    output. Without stripping the reminder, the user message fails to
 *    match, its paired assistant `tool_use` is left orphaned, and Anthropic
 *    rejects the request with a tool-pairing error.
 *    Symptom: 400 from the API after editing files inside a compressed
 *    range.
 *
 * 4. **Reduce `tool_use` blocks to {type, id, name, input}.** JSONL stores
 *    assistant `tool_use` blocks with extra fields (notably `caller`) that
 *    the API request body omits. Including those fields in the comparison
 *    key makes equal blocks compare unequal — and asymmetrically: the user
 *    `tool_result` may match while its paired assistant `tool_use` does not,
 *    leaving an orphaned `tool_use` and producing the same kind of pairing
 *    error.
 *    Symptom: "tool use concurrency" errors after compressing a range
 *    containing multiple tool calls.
 *
 * Note that this function is used on **both** sides of the comparison —
 * request messages and JSONL messages both pass through it before their
 * keys are computed. Adding a new normalization rule therefore tightens the
 * matcher symmetrically; it can't accidentally make one side stricter than
 * the other.
 */
function normalizeContent(content: string | unknown[]): string | unknown[] {
  if (typeof content === "string") {
    return trimSingleTrailingNewline(content);
  }
  const normalized: unknown[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      normalized.push(block);
      continue;
    }

    const record = block as Record<string, unknown>;
    if (record["type"] === "thinking") {
      continue;
    }

    if (record["type"] === "tool_result") {
      normalized.push(normalizeToolResultBlock(record));
      continue;
    }

    if (record["type"] === "tool_use") {
      normalized.push(normalizeToolUseBlock(record));
      continue;
    }

    if (record["type"] === "text" && typeof record["text"] === "string") {
      normalized.push({
        ...record,
        text: trimSingleTrailingNewline(record["text"]),
      });
      continue;
    }

    normalized.push(block);
  }
  return normalized;
}

function trimSingleTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function normalizeToolResultBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const content = block["content"];
  if (typeof content !== "string") {
    return block;
  }
  return {
    ...block,
    content: stripInjectedSystemReminder(trimSingleTrailingNewline(content)),
  };
}

function normalizeToolUseBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: block["type"],
    id: block["id"],
    name: block["name"],
    input: block["input"],
  };
}

function stripInjectedSystemReminder(text: string): string {
  const match = text.match(/\n\n<system-reminder>\n[\s\S]*<\/system-reminder>$/);
  if (match === null) return text;
  return text.slice(0, match.index);
}

/**
 * Format the content that will replace an anchor message.
 *
 * For Stage 1, we replace with a simple text block prefixed with a marker
 * indicating the substitution. The marker is informational; it tells the
 * model "this is a summary of N original messages, block_id X" without
 * commanding any action.
 *
 * `originalContent` is unused in Stage 1; reserved for future variants
 * that might preserve some structure (e.g., keep original tool_use blocks).
 */
function formatSummaryContent(
  block: Block,
  _originalContent: string | unknown[],
): string {
  const focus = block.focus !== null ? ` — ${block.focus}` : "";
  return (
    `[shelved: block ${block.block_id}, ${block.compressed_uuids.length} messages${focus}]\n\n` +
    block.summary
  );
}
