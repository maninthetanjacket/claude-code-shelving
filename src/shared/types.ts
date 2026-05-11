/**
 * Canonical block record: a single compression in the registry.
 *
 * Persisted as JSON at ~/.claude/shelving/<session-id>/<block-id>.json.
 * Both the MCP server and the proxy read these files; only the MCP server writes.
 */
export interface Block {
  /** Stable, monotonic per-session block identifier. */
  block_id: number;

  /** ISO-8601 timestamp of when this block was first created. */
  created_at: string;

  /**
   * Whether this block is currently substituting in the proxy.
   * - `true`: the proxy replaces the anchor message with `summary` and drops the rest.
   * - `false`: shelved-but-decompressed; the proxy ignores this block.
   *
   * `decompress` flips this to false; `recompress` flips it back to true.
   * Inactive blocks remain on disk so `recompress` can reactivate them
   * with byte-identical content (preserving cache stability).
   */
  active: boolean;

  /**
   * The message UUID at which the summary appears in the substituted request.
   * Convention: chronologically first UUID in `compressed_uuids`.
   */
  anchor_uuid: string;

  /**
   * All message UUIDs covered by this compression, in order.
   * The anchor message is replaced with `summary`; the rest are dropped.
   */
  compressed_uuids: string[];

  /** Model-authored summary text that replaces the anchor message's content. */
  summary: string;

  /** Token count of the original (pre-substitution) covered messages. */
  original_tokens: number;

  /** Token count of the summary itself. */
  summary_tokens: number;

  /**
   * Optional model-authored metadata describing what the summary preserved.
   * Not used by the substitution logic; stored for debugging and operator visibility.
   */
  focus: string | null;

  /**
   * If this block consumed an earlier overlapping block, that block's id.
   * Decompressing this block reactivates the parent (its summary returns),
   * not the original full content. Decompressing the parent (when active)
   * restores full content for the affected UUIDs.
   *
   * Stage 1 leaves this null for all blocks; nested compression deferred.
   */
  parent_block_id: number | null;
}

/**
 * Lightweight block metadata for listing operations.
 * Excludes the full `summary` text and `compressed_uuids` array
 * to keep listing cheap when many blocks exist.
 */
export interface BlockMeta {
  block_id: number;
  created_at: string;
  active: boolean;
  anchor_uuid: string;
  compressed_uuid_count: number;
  original_tokens: number;
  summary_tokens: number;
  focus: string | null;
  parent_block_id: number | null;
}

/** Convert a full Block to its metadata-only form. */
export function blockToMeta(block: Block): BlockMeta {
  return {
    block_id: block.block_id,
    created_at: block.created_at,
    active: block.active,
    anchor_uuid: block.anchor_uuid,
    compressed_uuid_count: block.compressed_uuids.length,
    original_tokens: block.original_tokens,
    summary_tokens: block.summary_tokens,
    focus: block.focus,
    parent_block_id: block.parent_block_id,
  };
}

/** Claude Code session identifier (UUID). */
export type SessionId = string;

/**
 * A bookmark records a labeled anchor UUID for later range-based compression.
 *
 * Workflow:
 *   1. Model calls `start_arc(label)` — bookmark captures the UUID of the most
 *      recent JSONL entry at invocation time (typically the user message that
 *      triggered the current assistant turn).
 *   2. Model does work (reads, edits, etc.) — JSONL grows.
 *   3. Model calls `compress_arc(label, summary)` — registry resolves the range
 *      from the bookmark UUID to the most recent user message at this call,
 *      submits as a Block. The current assistant turn (with the compress_arc
 *      call and any preceding reflection text) is naturally excluded because
 *      it is not yet a user message.
 *
 * Bookmarks live alongside blocks in the per-session directory but in a single
 * file (`bookmarks.json`) keyed by label. Labels are scoped per session.
 */
export interface Bookmark {
  /** Model-chosen label for this bookmark. Unique within a session. */
  label: string;

  /**
   * The JSONL message UUID this bookmark anchors at. Captured at start_arc
   * time as the most recent JSONL entry, which is typically the user message
   * that triggered the assistant turn containing the start_arc call.
   */
  anchor_uuid: string;

  /** ISO-8601 timestamp of when this bookmark was created. */
  created_at: string;
}

/**
 * On-disk shape of the per-session bookmarks file.
 * Wraps the bookmark map in an object with a version field for future
 * schema evolution without breaking older readers.
 */
export interface BookmarkFile {
  version: 1;
  bookmarks: Record<string, Bookmark>;
}
