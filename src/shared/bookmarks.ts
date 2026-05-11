import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Bookmark, BookmarkFile, SessionId } from "./types.js";
import {
  bookmarksPath,
  bookmarksTempPath,
  sessionDir,
} from "./paths.js";

/**
 * Bookmark registry: read/write the per-session bookmarks file.
 *
 * Design notes:
 * - Bookmarks live in a single file per session (not one-file-per-bookmark)
 *   because they're small and there will typically be few of them at any
 *   given time. The map shape is also more natural for label lookup.
 * - Reads are non-blocking; the file is small. No proxy cache needed —
 *   bookmarks are only read by the MCP server, not by the proxy.
 * - Writes are atomic (write-temp-then-rename), same pattern as block writes.
 * - There is no cross-process locking. The MCP server is the only writer.
 *
 * Schema versioning: the on-disk file has a `version: 1` field. Future
 * schema changes should bump the version and add a migration path here.
 */

const CURRENT_VERSION = 1;

function emptyFile(): BookmarkFile {
  return { version: CURRENT_VERSION, bookmarks: {} };
}

/** Read the bookmarks file for a session. Returns empty if it doesn't exist. */
export async function readBookmarks(sessionId: SessionId): Promise<BookmarkFile> {
  const path = bookmarksPath(sessionId);
  if (!existsSync(path)) return emptyFile();
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["version"] !== CURRENT_VERSION
  ) {
    // Unrecognized version: treat as empty and overwrite on next write.
    // The MCP server is the only writer, so this is safe.
    return emptyFile();
  }
  const file = parsed as BookmarkFile;
  if (typeof file.bookmarks !== "object" || file.bookmarks === null) {
    return emptyFile();
  }
  return file;
}

/**
 * Write the bookmarks file atomically. Creates the session directory
 * if it doesn't exist.
 */
async function writeBookmarks(
  sessionId: SessionId,
  file: BookmarkFile,
): Promise<void> {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tempPath = bookmarksTempPath(sessionId);
  const finalPath = bookmarksPath(sessionId);
  await writeFile(tempPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
  await rename(tempPath, finalPath);
}

/** Look up a single bookmark by label. Returns null if not found. */
export async function getBookmark(
  sessionId: SessionId,
  label: string,
): Promise<Bookmark | null> {
  const file = await readBookmarks(sessionId);
  return file.bookmarks[label] ?? null;
}

/**
 * Create or replace a bookmark. If a bookmark with this label already
 * exists, it is overwritten. The returned bookmark is the newly written one.
 */
export async function setBookmark(
  sessionId: SessionId,
  bookmark: Bookmark,
): Promise<Bookmark> {
  const file = await readBookmarks(sessionId);
  file.bookmarks[bookmark.label] = bookmark;
  await writeBookmarks(sessionId, file);
  return bookmark;
}

/** Remove a bookmark by label. Returns true if removed, false if not present. */
export async function deleteBookmark(
  sessionId: SessionId,
  label: string,
): Promise<boolean> {
  const file = await readBookmarks(sessionId);
  if (!(label in file.bookmarks)) return false;
  delete file.bookmarks[label];
  await writeBookmarks(sessionId, file);
  return true;
}

/** List all bookmarks for a session, sorted by created_at ascending. */
export async function listBookmarks(sessionId: SessionId): Promise<Bookmark[]> {
  const file = await readBookmarks(sessionId);
  const bookmarks = Object.values(file.bookmarks);
  bookmarks.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return bookmarks;
}
