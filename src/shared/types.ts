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
