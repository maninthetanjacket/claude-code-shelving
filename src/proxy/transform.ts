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
 * Matching strategy: layered, with progressively more forgiving identity.
 *
 * 1. Whole-message content match. Each request message is normalized and
 *    compared against the UUID→content map. If a whole message matches, we
 *    know its UUID and can check membership in active blocks.
 *
 * 2. Fragment-level content match. When whole-message matching fails
 *    (because CC has combined multiple JSONL entries into one API message —
 *    e.g., thinking + text + tool_use), each content block is matched
 *    individually via `fragmentKeyForBlock`. This recovers the UUIDs of
 *    constituent fragments even when their containing message has no exact
 *    equivalent in JSONL.
 *
 * 3. Tool-pair ID match as backstop. When content matching fails entirely —
 *    e.g., a tool_use's input bytes drift between JSONL and the API request,
 *    or a tool_result's content carries new harness annotations we haven't
 *    seen before — we fall back to matching by tool_use.id (for assistant
 *    tool_use blocks) and tool_result.tool_use_id (for user tool_result
 *    blocks). These IDs are stable across the JSONL/request boundary and
 *    keep the two sides of a tool exchange in the same block, preventing the
 *    asymmetric-drop / orphaned-tool_use failure mode.
 *
 * Anchor-seen filter: before substituting, we verify that the block's anchor
 * UUID was matched somewhere in this request. Without this, a request that
 * contains only drop-targets (no anchor) could lose them with nothing to
 * substitute at the anchor position. The filter ensures all-or-nothing
 * application per block per request.
 *
 * Fragment substitution: when a compressed UUID is only one fragment inside a
 * larger API message, `rewriteEmbeddedBlockContent` rewrites just those
 * fragments in place. Anchor fragments become the summary; drop fragments are
 * omitted; unrelated fragments are preserved. This prevents mixed user turns
 * (for example: live tool_result + newly typed follow-up text) from losing the
 * live tool_result when only the follow-up text belongs to a compressed block.
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
  role: "user" | "assistant" | "system";
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
  parent_uuid?: string;
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
  /** Per-block decisions for this request, ordered by block id. */
  block_decisions: BlockDecision[];
  /** Active blocks skipped for this request, with the reason from the code path taken. */
  blocks_skipped: BlockSkippedInfo[];
}

export type BlockSkipReason =
  | "anchor-not-found"
  | "anchor-content-mismatch"
  | `conflict-with-block-${number}`;

export interface BlockSkippedInfo {
  block_id: number;
  reason: BlockSkipReason;
}

export type BlockDecision =
  | { block_id: number; status: "applied" }
  | { block_id: number; status: "skipped"; reason: BlockSkipReason };

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
      block_decisions: [],
      blocks_skipped: [],
    };
  }

  const expandedBlocks = expandBlocksForChildMedia(activeBlocks, jsonlMessages);

  // Build exact content-key → uuid map from the JSONL, plus a fragment index
  // for cases where CC combines multiple logical messages into one API message
  // or adds transport-only blocks like assistant thinking.
  // If two UUIDs share a content-key, last one wins (rare; documented).
  const keyToUuid = new Map<string, string>();
  const fragmentKeyToUuids = new Map<string, string[]>();
  const toolUseIdToUuids = new Map<string, string[]>();
  const toolResultIdToUuids = new Map<string, string[]>();
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
    indexToolPairIds(m, toolUseIdToUuids, toolResultIdToUuids);
  }

  // Build uuid → block lookup for each active block, plus uuid → role-in-block.
  // role_in_block: "anchor" or "drop".
  type Role = "anchor" | "drop";
  const uuidToBlock = new Map<string, { block: Block; role: Role }>();
  for (const block of expandedBlocks) {
    for (let i = 0; i < block.compressed_uuids.length; i++) {
      const uuid = block.compressed_uuids[i];
      if (uuid === undefined) continue;
      const role: Role = uuid === block.anchor_uuid ? "anchor" : "drop";
      uuidToBlock.set(uuid, { block, role });
    }
  }

  type BlockTrace = {
    block_id: number;
    anyUuidMatched: boolean;
    anchorSeen: boolean;
    applied: boolean;
    conflictWith: number | null;
  };

  const blockTraceById = new Map<number, BlockTrace>();
  for (const block of expandedBlocks) {
    blockTraceById.set(block.block_id, {
      block_id: block.block_id,
      anyUuidMatched: false,
      anchorSeen: false,
      applied: false,
      conflictWith: null,
    });
  }

  const newMessages: ApiMessage[] = [];
  const blocksApplied = new Set<number>();
  const anchorSeenByBlockId = new Set<number>();
  let anchorsSubstituted = 0;
  let messagesDropped = 0;

  const resolvedPerMessage = request.messages.map((apiMsg) =>
    resolveMessageMatch(
      apiMsg,
      keyToUuid,
      fragmentKeyToUuids,
      toolUseIdToUuids,
      toolResultIdToUuids,
    ),
  );

  for (const resolved of resolvedPerMessage) {
    for (const uuid of resolved.matchedUuids) {
      const hit = uuidToBlock.get(uuid);
      if (hit !== undefined) {
        const trace = blockTraceById.get(hit.block.block_id);
        if (trace !== undefined) {
          trace.anyUuidMatched = true;
        }
      }
      if (hit?.role === "anchor") {
        anchorSeenByBlockId.add(hit.block.block_id);
        const trace = blockTraceById.get(hit.block.block_id);
        if (trace !== undefined) {
          trace.anchorSeen = true;
        }
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
      const disambiguatedBlockId = selectDominantBlockId(apiMsg, resolved, uuidToBlock);
      if (disambiguatedBlockId === null) {
        // Ambiguous: this API message appears to contain content from multiple
        // blocks. Fail safe to passthrough rather than risking a wrong rewrite.
        const ids = Array.from(blockIds).sort((a, b) => a - b);
        for (const blockId of ids) {
          const trace = blockTraceById.get(blockId);
          if (trace === undefined || trace.conflictWith !== null) continue;
          trace.conflictWith = ids.find((id) => id !== blockId) ?? null;
        }
        newMessages.push(apiMsg);
        continue;
      }
      blockHits.splice(
        0,
        blockHits.length,
        ...blockHits.filter((entry) => entry.hit.block.block_id === disambiguatedBlockId),
      );
    }

    const blockHit = blockHits[0];
    if (blockHit === undefined) {
      newMessages.push(apiMsg);
      continue;
    }

    const block = blockHit.hit.block;
    const containsAnchor = blockHits.some((entry) => entry.hit.role === "anchor");

    blocksApplied.add(block.block_id);
    const trace = blockTraceById.get(block.block_id);
    if (trace !== undefined) {
      trace.applied = true;
    }
    if (containsAnchor) {
      const rewrittenContent = rewriteEmbeddedBlockContent(
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
      const rewrittenContent = rewriteEmbeddedBlockContent(
        apiMsg,
        block,
        resolved,
        uuidToBlock,
      );
      if (rewrittenContent === null) {
        // Drop this message entirely.
        messagesDropped++;
        continue;
      }

      if (
        Array.isArray(rewrittenContent) &&
        rewrittenContent.length === 0
      ) {
        messagesDropped++;
        continue;
      }

      newMessages.push({
        role: apiMsg.role,
        content: rewrittenContent,
      });
    }
  }

  const blocksAppliedList = Array.from(blocksApplied).sort((a, b) => a - b);
  const blocksInactive = expandedBlocks
    .map((b) => b.block_id)
    .filter((id) => !blocksApplied.has(id))
    .sort((a, b) => a - b);
  const blockDecisions = buildBlockDecisions(expandedBlocks, blockTraceById);

  return {
    request: { ...request, messages: normalizeMessageSequence(newMessages) },
    anchors_substituted: anchorsSubstituted,
    messages_dropped: messagesDropped,
    blocks_applied: blocksAppliedList,
    blocks_inactive_in_request: blocksInactive,
    block_decisions: blockDecisions,
    blocks_skipped: blockDecisions
      .filter(
        (decision): decision is { block_id: number; status: "skipped"; reason: BlockSkipReason } =>
          decision.status === "skipped",
      )
      .map(({ block_id, reason }) => ({ block_id, reason })),
  };
}

function buildBlockDecisions(
  blocks: Block[],
  blockTraceById: Map<number, {
    block_id: number;
    anyUuidMatched: boolean;
    anchorSeen: boolean;
    applied: boolean;
    conflictWith: number | null;
  }>,
): BlockDecision[] {
  return blocks
    .map((block) => blockTraceById.get(block.block_id))
    .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined)
    .sort((a, b) => a.block_id - b.block_id)
    .map((trace) => {
      if (trace.applied) {
        return { block_id: trace.block_id, status: "applied" } as const;
      }
      return {
        block_id: trace.block_id,
        status: "skipped",
        reason: blockSkipReason(trace),
      } as const;
    });
}

function blockSkipReason(trace: {
  anyUuidMatched: boolean;
  anchorSeen: boolean;
  conflictWith: number | null;
}): BlockSkipReason {
  if (!trace.anyUuidMatched) {
    return "anchor-not-found";
  }
  if (!trace.anchorSeen) {
    return "anchor-content-mismatch";
  }
  if (trace.conflictWith !== null) {
    return `conflict-with-block-${trace.conflictWith}`;
  }
  return "anchor-not-found";
}

function selectDominantBlockId(
  message: ApiMessage,
  resolved: ResolvedMessageMatch | undefined,
  uuidToBlock: Map<string, { block: Block; role: "anchor" | "drop" }>,
): number | null {
  if (resolved === undefined) return null;

  const uniqueSupportByBlockId = new Map<number, number>();
  if (resolved.exactUuid !== null) {
    const hit = uuidToBlock.get(resolved.exactUuid);
    if (hit !== undefined) {
      uniqueSupportByBlockId.set(hit.block.block_id, 1);
    }
  }

  if (Array.isArray(message.content)) {
    for (let i = 0; i < message.content.length; i++) {
      const fragmentMatch = resolved.fragmentMatches[i];
      if (fragmentMatch === undefined) continue;
      collectUniqueFragmentSupport(fragmentMatch, uniqueSupportByBlockId, uuidToBlock);
    }
  }

  const supportedBlocks = Array.from(uniqueSupportByBlockId.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (supportedBlocks.length !== 1) {
    return null;
  }
  return supportedBlocks[0]?.[0] ?? null;
}

function collectUniqueFragmentSupport(
  resolved: ResolvedBlockMatch,
  uniqueSupportByBlockId: Map<number, number>,
  uuidToBlock: Map<string, { block: Block; role: "anchor" | "drop" }>,
): void {
  const directBlockIds = Array.from(
    new Set(
      resolved.directMatchedUuids
        .map((uuid) => uuidToBlock.get(uuid)?.block.block_id)
        .filter((blockId): blockId is number => blockId !== undefined),
    ),
  );

  if (directBlockIds.length === 1) {
    const blockId = directBlockIds[0];
    if (blockId !== undefined) {
      uniqueSupportByBlockId.set(
        blockId,
        (uniqueSupportByBlockId.get(blockId) ?? 0) + 1,
      );
    }
  }

  for (const nested of resolved.nestedMatches) {
    collectUniqueFragmentSupport(nested, uniqueSupportByBlockId, uuidToBlock);
  }
}

function expandBlocksForChildMedia(
  activeBlocks: Block[],
  jsonlMessages: JsonlMessage[],
): Block[] {
  const turns = collectCollapsedTurnsMetadata(jsonlMessages);
  if (turns.length === 0) return activeBlocks;
  return activeBlocks.map((block) => expandBlockForChildMedia(block, turns));
}

type CollapsedTurnMetadata = {
  uuid: string;
  role: "user" | "assistant";
  parentUuid: string | null;
  messages: JsonlMessage[];
};

function collectCollapsedTurnsMetadata(messages: JsonlMessage[]): CollapsedTurnMetadata[] {
  const turns: CollapsedTurnMetadata[] = [];
  let current: CollapsedTurnMetadata | null = null;

  for (const message of messages) {
    if (current === null || current.uuid !== message.uuid) {
      current = {
        uuid: message.uuid,
        role: message.role,
        parentUuid: message.parent_uuid ?? null,
        messages: [message],
      };
      turns.push(current);
      continue;
    }

    if (current.parentUuid === null && typeof message.parent_uuid === "string") {
      current.parentUuid = message.parent_uuid;
    }
    current.messages.push(message);
  }

  return turns;
}

function expandBlockForChildMedia(block: Block, turns: CollapsedTurnMetadata[]): Block {
  const expandedUuids = [...block.compressed_uuids];
  const covered = new Set(expandedUuids);
  let endPos = -1;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn !== undefined && turn.uuid === expandedUuids[expandedUuids.length - 1]) {
      endPos = i;
      break;
    }
  }
  if (endPos === -1) return block;

  for (;;) {
    const nextTurn = turns[endPos + 1];
    if (nextTurn === undefined) break;
    if (!isMediaOnlyChildTurn(nextTurn, turns, covered)) break;
    expandedUuids.push(nextTurn.uuid);
    covered.add(nextTurn.uuid);
    endPos += 1;
  }

  if (expandedUuids.length === block.compressed_uuids.length) {
    return block;
  }

  return {
    ...block,
    compressed_uuids: expandedUuids,
  };
}

function isMediaOnlyChildTurn(
  turn: CollapsedTurnMetadata,
  turns: CollapsedTurnMetadata[],
  covered: Set<string>,
): boolean {
  if (turn.role !== "user" || turn.parentUuid === null) return false;
  if (!turnContainsOnlyMedia(turn.messages)) return false;

  const parentTurn = turns.find((candidate) => candidate.uuid === turn.parentUuid);
  if (parentTurn === undefined || !covered.has(parentTurn.uuid)) return false;

  return turnContainsToolResult(parentTurn.messages) || turnContainsOnlyMedia(parentTurn.messages);
}

function turnContainsOnlyMedia(messages: JsonlMessage[]): boolean {
  let sawBlock = false;

  for (const message of messages) {
    if (!Array.isArray(message.content)) return false;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) return false;
      const type = (block as Record<string, unknown>)["type"];
      if (type !== "image" && type !== "document") {
        return false;
      }
      sawBlock = true;
    }
  }

  return sawBlock;
}

function turnContainsToolResult(messages: JsonlMessage[]): boolean {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "tool_result"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Repair the message sequence after substitution + drop.
 *
 * Dropping UUID-matched conversation turns can strand the non-UUID artifacts
 * that CC interleaves into a request — chiefly `role:"system"` reminders, which
 * have no JSONL UUID and therefore pass through the matcher untouched. Two
 * invalid shapes result, both of which the API rejects:
 *
 *  1. Orphaned / misplaced system reminders. A reminder is only valid when it
 *     still sits between a permitted predecessor (a `user` turn, or an
 *     `assistant` turn ending in a `server_tool_result`) and a permitted
 *     successor (`assistant` or end-of-array). Compression can strand the
 *     reminder after the wrong turn or in front of a `user` turn, and the API
 *     rejects the request.
 *
 *  2. Same-role adjacency. Collapsing a range whose anchor is a user message and
 *     whose following message is also a user message leaves two user turns back
 *     to back once the assistant turns between them are gone.
 *
 * This pass fixes both: it drops system reminders that no longer have a valid
 * predecessor/successor placement, then merges any consecutive same-role
 * user/assistant messages. It is a no-op on an already-valid sequence, so it
 * leaves untouched passthrough requests byte-identical.
 */
function normalizeMessageSequence(messages: ApiMessage[]): ApiMessage[] {
  // 1. Prune orphaned / misplaced system reminders.
  const pruned: ApiMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (message.role === "system") {
      const previous = findPreviousNonSystem(pruned);
      const next = findNextNonSystem(messages, i + 1);
      if (hasValidSystemPredecessor(previous) && hasValidSystemSuccessor(next)) {
        pruned.push({ ...message });
      }
      continue;
    }
    pruned.push({ ...message });
  }

  // 2. Merge consecutive same-role user/assistant messages.
  const merged: ApiMessage[] = [];
  for (const message of pruned) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      prev.role === message.role &&
      (message.role === "user" || message.role === "assistant")
    ) {
      prev.content = mergeContents(prev.content, message.content);
    } else {
      // Shallow copy so merges never mutate the caller's request objects.
      merged.push({ ...message });
    }
  }
  return merged;
}

function findPreviousNonSystem(messages: ApiMessage[]): ApiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role !== "system") {
      return message;
    }
  }
  return undefined;
}

function findNextNonSystem(
  messages: ApiMessage[],
  startIndex: number,
): ApiMessage | undefined {
  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i];
    if (message !== undefined && message.role !== "system") {
      return message;
    }
  }
  return undefined;
}

function hasValidSystemPredecessor(message: ApiMessage | undefined): boolean {
  if (message === undefined) return false;
  if (message.role === "user") return true;
  return message.role === "assistant" && messageEndsInServerToolResult(message);
}

function hasValidSystemSuccessor(message: ApiMessage | undefined): boolean {
  return message === undefined || message.role === "assistant";
}

function messageEndsInServerToolResult(message: ApiMessage): boolean {
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  const lastBlock = message.content[message.content.length - 1];
  if (typeof lastBlock !== "object" || lastBlock === null) {
    return false;
  }
  return (lastBlock as Record<string, unknown>)["type"] === "server_tool_result";
}

function mergeContents(
  a: string | unknown[],
  b: string | unknown[],
): unknown[] {
  return [...contentToBlocks(a), ...contentToBlocks(b)];
}

function contentToBlocks(content: string | unknown[]): unknown[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return content;
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
  const normalized = normalizeContent(role, content);
  if (typeof normalized === "string") {
    return `${role}:s:${normalized}`;
  }
  return `${role}:a:${JSON.stringify(normalized)}`;
}

function fragmentKeys(role: string, content: string | unknown[]): string[] {
  const normalized = normalizeContent(role, content);
  if (typeof normalized === "string") {
    return [`${role}:f:${normalized}`];
  }
  const keys: string[] = [];
  for (const block of normalized) {
    collectFragmentKeys(role, block, keys);
  }
  return keys;
}

function collectFragmentKeys(role: string, block: unknown, keys: string[]): void {
  const key = fragmentKeyForBlock(role, block);
  if (key !== null) keys.push(key);

  const nested = nestedToolResultContent(block);
  if (nested === null) return;
  for (const item of nested) {
    collectFragmentKeys(role, item, keys);
  }
}

interface ResolvedMessageMatch {
  matchedUuids: string[];
  exactUuid: string | null;
  fragmentMatches: ResolvedBlockMatch[];
}

interface ResolvedBlockMatch {
  matchedUuids: string[];
  directMatchedUuids: string[];
  nestedMatches: ResolvedBlockMatch[];
}

function resolveMessageMatch(
  message: ApiMessage,
  keyToUuid: Map<string, string>,
  fragmentKeyToUuids: Map<string, string[]>,
  toolUseIdToUuids: Map<string, string[]>,
  toolResultIdToUuids: Map<string, string[]>,
): ResolvedMessageMatch {
  const exact = keyToUuid.get(contentKey(message.role, message.content));
  if (exact !== undefined) {
    return {
      matchedUuids: [exact],
      exactUuid: exact,
      fragmentMatches: Array.isArray(message.content)
        ? message.content.map(() => ({
            matchedUuids: [],
            directMatchedUuids: [],
            nestedMatches: [],
          }))
        : [],
    };
  }

  if (!Array.isArray(message.content)) {
    return { matchedUuids: [], exactUuid: null, fragmentMatches: [] };
  }

  const matched = new Set<string>();
  const fragmentMatches = message.content.map((block) =>
    resolveBlockMatch(
      message.role,
      block,
      fragmentKeyToUuids,
      toolUseIdToUuids,
      toolResultIdToUuids,
      true,
    ),
  );
  for (const fragmentMatch of fragmentMatches) {
    for (const uuid of fragmentMatch.matchedUuids) {
      matched.add(uuid);
    }
  }
  return {
    matchedUuids: Array.from(matched),
    exactUuid: null,
    fragmentMatches,
  };
}

function resolveBlockMatch(
  role: "user" | "assistant" | "system",
  block: unknown,
  fragmentKeyToUuids: Map<string, string[]>,
  toolUseIdToUuids: Map<string, string[]>,
  toolResultIdToUuids: Map<string, string[]>,
  allowToolPairFallback: boolean,
): ResolvedBlockMatch {
  const matched = new Set<string>();
  const directMatched = new Set<string>();

  if (allowToolPairFallback) {
    const directToolUuids = directToolPairUuidsForBlock(
      role,
      block,
      toolUseIdToUuids,
      toolResultIdToUuids,
    );
    for (const uuid of directToolUuids) {
      matched.add(uuid);
      directMatched.add(uuid);
    }
  }

  const key = fragmentKeyForBlock(role, block);
  if (key !== null) {
    for (const uuid of fragmentKeyToUuids.get(key) ?? []) {
      matched.add(uuid);
      directMatched.add(uuid);
    }
  }

  const nestedMatches: ResolvedBlockMatch[] = [];
  for (const item of nestedToolResultContent(block) ?? []) {
    const nestedMatch = resolveBlockMatch(
      role,
      item,
      fragmentKeyToUuids,
      toolUseIdToUuids,
      toolResultIdToUuids,
      false,
    );
    nestedMatches.push(nestedMatch);
    for (const uuid of nestedMatch.matchedUuids) {
      matched.add(uuid);
    }
  }

  return {
    matchedUuids: Array.from(matched),
    directMatchedUuids: Array.from(directMatched),
    nestedMatches,
  };
}

function directToolPairUuidsForBlock(
  role: "user" | "assistant" | "system",
  block: unknown,
  toolUseIdToUuids: Map<string, string[]>,
  toolResultIdToUuids: Map<string, string[]>,
): string[] {
  if (role === "assistant") {
    const toolUseId = getToolUseId(block);
    return toolUseId === null ? [] : (toolUseIdToUuids.get(toolUseId) ?? []);
  }

  const toolResultId = getToolResultToolUseId(block);
  return toolResultId === null ? [] : (toolResultIdToUuids.get(toolResultId) ?? []);
}

function fragmentKeyForBlock(role: string, block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const record = block as Record<string, unknown>;
  if (record["type"] === "text") {
    const text = record["text"];
    if (typeof text !== "string") return null;
    return `${role}:f:${normalizeTextForMatch(role, text)}`;
  }
  if (record["type"] === "tool_use") {
    return `${role}:f:${JSON.stringify(normalizeToolUseBlock(record))}`;
  }
  if (record["type"] === "tool_result") {
    return `${role}:f:${JSON.stringify(normalizeToolResultBlock(record))}`;
  }
  if (record["type"] === "image") {
    return `${role}:f:${JSON.stringify(normalizeImageBlock(record))}`;
  }
  if (record["type"] === "document") {
    return `${role}:f:${JSON.stringify(normalizeDocumentBlock(record))}`;
  }
  if (record["type"] === "search_result") {
    return `${role}:f:${JSON.stringify(normalizeSearchResultBlock(record))}`;
  }
  return null;
}

function getToolUseId(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const record = block as Record<string, unknown>;
  return record["type"] === "tool_use" && typeof record["id"] === "string"
    ? record["id"]
    : null;
}

function getToolResultToolUseId(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const record = block as Record<string, unknown>;
  return record["type"] === "tool_result" && typeof record["tool_use_id"] === "string"
    ? record["tool_use_id"]
    : null;
}

function rewriteEmbeddedBlockContent(
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
    const rewrite = rewriteResolvedBlock(
      originalBlock,
      resolved.fragmentMatches[i],
      block,
      uuidToBlock,
      replacedAnchor,
      message.content,
    );
    touched ||= rewrite.touched;
    replacedAnchor ||= rewrite.replacedAnchor;
    if (rewrite.value !== null) {
      rewritten.push(rewrite.value);
    }
  }

  if (!touched) {
    return null;
  }

  if (replacedAnchor) {
    return rewritten;
  }

  if (!touched) {
    return null;
  }
  return rewritten;
}

function rewriteResolvedBlock(
  originalBlock: unknown,
  resolved: ResolvedBlockMatch | undefined,
  block: Block,
  uuidToBlock: Map<string, { block: Block; role: "anchor" | "drop" }>,
  anchorAlreadyReplaced: boolean,
  summaryContext: string | unknown[],
): { value: unknown | null; touched: boolean; replacedAnchor: boolean } {
  if (resolved === undefined) {
    return { value: originalBlock, touched: false, replacedAnchor: false };
  }

  const directHits = resolved.directMatchedUuids
    .map((uuid) => uuidToBlock.get(uuid))
    .filter(
      (hit): hit is { block: Block; role: "anchor" | "drop" } =>
        hit !== undefined && hit.block.block_id === block.block_id,
    );

  if (directHits.length > 0) {
    if (directHits.some((hit) => hit.role === "anchor")) {
      if (anchorAlreadyReplaced) {
        return { value: null, touched: true, replacedAnchor: true };
      }
      return {
        value: {
          type: "text",
          text: formatSummaryContent(block, summaryContext),
        },
        touched: true,
        replacedAnchor: true,
      };
    }
    return { value: null, touched: true, replacedAnchor: false };
  }

  const nested = nestedToolResultContent(originalBlock);
  if (nested === null || resolved.nestedMatches.length === 0) {
    return { value: originalBlock, touched: false, replacedAnchor: false };
  }

  let touched = false;
  let replacedAnchor = false;
  const rewrittenNested: unknown[] = [];
  for (let i = 0; i < nested.length; i++) {
    const nestedRewrite = rewriteResolvedBlock(
      nested[i],
      resolved.nestedMatches[i],
      block,
      uuidToBlock,
      anchorAlreadyReplaced || replacedAnchor,
      summaryContext,
    );
    touched ||= nestedRewrite.touched;
    replacedAnchor ||= nestedRewrite.replacedAnchor;
    if (nestedRewrite.value !== null) {
      rewrittenNested.push(nestedRewrite.value);
    }
  }

  if (!touched) {
    return { value: originalBlock, touched: false, replacedAnchor: false };
  }

  if (
    typeof originalBlock !== "object" ||
    originalBlock === null ||
    (originalBlock as Record<string, unknown>)["type"] !== "tool_result"
  ) {
    return { value: originalBlock, touched: false, replacedAnchor };
  }

  return {
    value: {
      ...(originalBlock as Record<string, unknown>),
      content: rewrittenNested,
    },
    touched: true,
    replacedAnchor,
  };
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
 * 5. **Strip assistant `[turn N]` prefixes before matching.** The proxy
 *    removes injected turn markers from assistant history before forwarding
 *    the request upstream, but older JSONL entries may already have been
 *    persisted with those prefixes. Treating the marker as semantic content
 *    makes the anchor UUID disappear after preprocessing, which causes the
 *    block-level all-or-nothing gate to skip the whole block even when the
 *    rest of the range still matches.
 *    Symptom: blocks authored under an earlier marker-injecting proxy appear
 *    inactive in later requests after the assistant markers are stripped.
 *
 * Note that this function is used on **both** sides of the comparison —
 * request messages and JSONL messages both pass through it before their
 * keys are computed. Adding a new normalization rule therefore tightens the
 * matcher symmetrically; it can't accidentally make one side stricter than
 * the other.
 */
function normalizeContent(role: string, content: string | unknown[]): string | unknown[] {
  if (typeof content === "string") {
    return normalizeTextForMatch(role, content);
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

    if (record["type"] === "image") {
      normalized.push(normalizeImageBlock(record));
      continue;
    }

    if (record["type"] === "document") {
      normalized.push(normalizeDocumentBlock(record));
      continue;
    }

    if (record["type"] === "search_result") {
      normalized.push(normalizeSearchResultBlock(record));
      continue;
    }

    if (record["type"] === "text" && typeof record["text"] === "string") {
      normalized.push({
        ...record,
        text: normalizeTextForMatch(role, record["text"]),
      });
      continue;
    }

    normalized.push(block);
  }
  return normalized;
}

function indexToolPairIds(
  message: JsonlMessage,
  toolUseIdToUuids: Map<string, string[]>,
  toolResultIdToUuids: Map<string, string[]>,
): void {
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    const toolUseId = getToolUseId(block);
    if (toolUseId !== null) {
      pushUnique(toolUseIdToUuids, toolUseId, message.uuid);
    }
    const toolResultId = getToolResultToolUseId(block);
    if (toolResultId !== null) {
      pushUnique(toolResultIdToUuids, toolResultId, message.uuid);
    }
  }
}

function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
}

function trimSingleTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

const TURN_MARKER_PREFIX_RE = /^(?:\[turn \d+\](?:\r?\n){2})+/;

function normalizeTextForMatch(role: string, text: string): string {
  const trimmed = trimSingleTrailingNewline(text);
  if (role !== "assistant") {
    return trimmed;
  }
  return trimmed.replace(TURN_MARKER_PREFIX_RE, "");
}

function normalizeToolResultBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...block,
    content: normalizeToolResultContent(block["content"]),
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

function normalizeImageBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: block["type"],
    source: block["source"],
  };
}

function normalizeDocumentBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: block["type"],
    source: block["source"],
  };
}

function normalizeSearchResultBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  return block;
}

function normalizeToolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripInjectedSystemReminder(trimSingleTrailingNewline(content));
  }
  if (Array.isArray(content)) {
    return content.map(normalizeNestedToolResultBlock);
  }
  if (typeof content === "object" && content !== null) {
    return normalizeNestedToolResultBlock(content);
  }
  return content;
}

function normalizeNestedToolResultBlock(block: unknown): unknown {
  if (typeof block !== "object" || block === null) {
    return block;
  }

  const record = block as Record<string, unknown>;
  if (record["type"] === "text" && typeof record["text"] === "string") {
    return {
      ...record,
      text: trimSingleTrailingNewline(record["text"]),
    };
  }
  if (record["type"] === "image") {
    return normalizeImageBlock(record);
  }
  if (record["type"] === "document") {
    return normalizeDocumentBlock(record);
  }
  if (record["type"] === "search_result") {
    return normalizeSearchResultBlock(record);
  }
  return block;
}

function nestedToolResultContent(block: unknown): unknown[] | null {
  if (typeof block !== "object" || block === null) return null;
  const record = block as Record<string, unknown>;
  if (record["type"] !== "tool_result") return null;
  return Array.isArray(record["content"]) ? record["content"] : null;
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
