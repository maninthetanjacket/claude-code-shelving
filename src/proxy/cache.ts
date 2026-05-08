import type { Block } from "../shared/types.js";
import type { JsonlMessage } from "./transform.js";
import { listActiveBlocks, sessionMtime } from "../shared/registry.js";
import { loadSessionMessages } from "./jsonl.js";

/**
 * Per-session cache for the two pieces of state the transform needs:
 *  - Active blocks from `~/.claude/shelving/<session>/`
 *  - JSONL messages from `~/.claude/projects/.../<session>.jsonl`
 *
 * Each is invalidated independently by mtime check. The check is a single
 * stat() per request per source (cheap), and the actual reads only happen
 * when mtime advances.
 *
 * Caches are keyed by session_id and live for the lifetime of the proxy
 * process. There is no eviction; in practice the working set is small
 * (a handful of active sessions). Add LRU later if needed.
 */

interface BlocksCacheEntry {
  mtime: number;
  blocks: Block[];
}

interface JsonlCacheEntry {
  mtime: number;
  path: string;
  messages: JsonlMessage[];
}

const blocksCache = new Map<string, BlocksCacheEntry>();
const jsonlCache = new Map<string, JsonlCacheEntry>();

/**
 * Get active blocks for a session, using the cache when possible.
 * Returns empty array if the session has no shelving directory.
 */
export async function getActiveBlocksCached(sessionId: string): Promise<Block[]> {
  const mtime = await sessionMtime(sessionId);
  if (mtime === null) {
    blocksCache.delete(sessionId);
    return [];
  }
  const cached = blocksCache.get(sessionId);
  if (cached !== undefined && cached.mtime === mtime) {
    return cached.blocks;
  }
  const blocks = await listActiveBlocks(sessionId);
  blocksCache.set(sessionId, { mtime, blocks });
  return blocks;
}

/**
 * Get JSONL messages for a session, using the cache when possible.
 * Returns empty array if the session JSONL is not found.
 */
export async function getJsonlMessagesCached(
  sessionId: string,
): Promise<JsonlMessage[]> {
  const cached = jsonlCache.get(sessionId);
  // First, peek at the cached entry's path to see if mtime is unchanged.
  if (cached !== undefined) {
    const { jsonlMtime } = await import("./jsonl.js");
    const m = await jsonlMtime(cached.path);
    if (m !== null && m === cached.mtime) {
      return cached.messages;
    }
  }

  // Cache miss or stale: do a full load (which also rediscovers the path
  // in case the session was just created or moved).
  const { path, messages, mtime } = await loadSessionMessages(sessionId);
  if (path === null || mtime === null) {
    jsonlCache.delete(sessionId);
    return [];
  }
  jsonlCache.set(sessionId, { mtime, path, messages });
  return messages;
}

/** Reset all caches; primarily for testing. */
export function clearCaches(): void {
  blocksCache.clear();
  jsonlCache.clear();
}
