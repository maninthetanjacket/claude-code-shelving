import { readFile, writeFile, readdir, mkdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Block, SessionId } from "./types.js";
import { blockPath, blockTempPath, sessionDir } from "./paths.js";

/**
 * Registry operations for substitution blocks. Both the MCP server and the proxy use these.
 *
 * Design notes:
 * - Reads are non-blocking and cheap (small JSON files). The proxy will layer
 *   its own in-memory cache on top, invalidated by directory mtime.
 * - Writes are atomic (write-then-rename) so the proxy never reads a partially
 *   written file. Concurrent reads during a write see either the old file or
 *   the new file, never a half-written one.
 * - There is no cross-process locking. The MCP server is the only writer; if
 *   two instances of the MCP server somehow ran for the same session, last
 *   write would win on `rename`. Acceptable for Stage 1.
 */

/** Read a single block by id. Returns null if the block does not exist. */
export async function readBlock(
  sessionId: SessionId,
  blockId: number,
): Promise<Block | null> {
  const path = blockPath(sessionId, blockId);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return normalizeBlockRecord(JSON.parse(raw) as Block);
}

/**
 * Write a block atomically: write to a temp file, then rename into place.
 * Creates the session directory if it doesn't exist.
 */
export async function writeBlock(
  sessionId: SessionId,
  block: Block,
): Promise<void> {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tempPath = blockTempPath(sessionId, block.block_id);
  const finalPath = blockPath(sessionId, block.block_id);
  const normalized = normalizeBlockRecord(block);
  // Trailing newline for human-readability when inspecting on disk.
  await writeFile(tempPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  await rename(tempPath, finalPath);
}

/**
 * List all blocks for a session, sorted by block_id ascending.
 * Returns an empty array if the session has no shelving directory.
 */
export async function listBlocks(sessionId: SessionId): Promise<Block[]> {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const blocks: Block[] = [];
  for (const entry of entries) {
    // Skip temp files and anything not matching <number>.json
    if (!/^\d+\.json$/.test(entry)) continue;
    const raw = await readFile(join(dir, entry), "utf-8");
    blocks.push(normalizeBlockRecord(JSON.parse(raw) as Block));
  }
  blocks.sort((a, b) => a.block_id - b.block_id);
  return blocks;
}

/** List only blocks where active === true. */
export async function listActiveBlocks(
  sessionId: SessionId,
): Promise<Block[]> {
  const all = await listBlocks(sessionId);
  return all.filter((b) => b.active);
}

/**
 * Compute the next block_id to assign for a new block in this session.
 * Block ids are monotonic per session, never reused.
 */
export async function nextBlockId(sessionId: SessionId): Promise<number> {
  const blocks = await listBlocks(sessionId);
  if (blocks.length === 0) return 1;
  return Math.max(...blocks.map((b) => b.block_id)) + 1;
}

/**
 * Set a block's active flag and write back. Returns the updated block,
 * or null if the block did not exist.
 */
export async function setBlockActive(
  sessionId: SessionId,
  blockId: number,
  active: boolean,
): Promise<Block | null> {
  const block = await readBlock(sessionId, blockId);
  if (block === null) return null;
  if (block.active === active) return block; // no-op
  block.active = active;
  await writeBlock(sessionId, block);
  return block;
}

/**
 * Get the directory mtime for the session's shelving directory.
 * The proxy uses this for cheap cache invalidation: if mtime hasn't changed
 * since last read, no block files were created/modified/deleted.
 *
 * Returns null if the directory doesn't exist (proxy treats as no-active-blocks).
 */
export async function sessionMtime(sessionId: SessionId): Promise<number | null> {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return null;
  const s = await stat(dir);
  return s.mtimeMs;
}

function normalizeBlockRecord(block: Block): Block {
  return {
    ...block,
    kind: block.kind === "placement" ? "placement" : "compression",
  };
}
