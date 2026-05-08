import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonlMessage } from "./transform.js";

/**
 * Read and parse Claude Code session JSONL files.
 *
 * CC stores per-session conversation logs at:
 *   ~/.claude/projects/<project-slug>/<session-id>.jsonl
 *
 * The project-slug encodes the working directory path. Since session IDs
 * are UUIDs and globally unique, we search across all project directories
 * to find the file by session id rather than reconstructing the slug.
 *
 * Each JSONL line is one entry. We only care about `type: "user"` and
 * `type: "assistant"` entries — those carry message UUIDs and content.
 * Other entry types (queue-operation, system internal, etc.) are ignored.
 */

/** Default root for CC projects, overridable for testing. */
function projectsRoot(): string {
  const override = process.env["CLAUDE_PROJECTS_DIR"];
  if (override !== undefined && override !== "") return override;
  return join(homedir(), ".claude", "projects");
}

/**
 * Find the session JSONL file for a given session id.
 * Returns null if not found.
 */
export async function findSessionJsonl(sessionId: string): Promise<string | null> {
  const root = projectsRoot();
  if (!existsSync(root)) return null;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return null;
  }

  const filename = `${sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = join(root, dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a session JSONL file into a list of `user` and `assistant` messages,
 * in file order, with their UUIDs.
 *
 * Lines that aren't valid JSON, or don't have type/user-or-assistant + uuid,
 * are silently skipped. This is defensive: CC has multiple entry types and
 * may add more; we only need the ones with model-visible content.
 */
export async function parseSessionJsonl(path: string): Promise<JsonlMessage[]> {
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n");
  const messages: JsonlMessage[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const type = e["type"];
    if (type !== "user" && type !== "assistant") continue;

    const uuid = e["uuid"];
    if (typeof uuid !== "string" || uuid.length === 0) continue;

    const message = e["message"];
    if (typeof message !== "object" || message === null) continue;
    const msg = message as Record<string, unknown>;

    const role = msg["role"];
    if (role !== "user" && role !== "assistant") continue;

    const content = msg["content"];
    if (typeof content !== "string" && !Array.isArray(content)) continue;

    messages.push({ uuid, role, content });
  }

  return messages;
}

/**
 * Get session JSONL mtime (in milliseconds), or null if file not found.
 */
export async function jsonlMtime(path: string): Promise<number | null> {
  if (!existsSync(path)) return null;
  const s = await stat(path);
  return s.mtimeMs;
}

/**
 * Convenience: find and parse in one call.
 * Returns empty array if the JSONL doesn't exist (proxy treats as no-op).
 */
export async function loadSessionMessages(
  sessionId: string,
): Promise<{ path: string | null; messages: JsonlMessage[]; mtime: number | null }> {
  const path = await findSessionJsonl(sessionId);
  if (path === null) {
    return { path: null, messages: [], mtime: null };
  }
  const [messages, mtime] = await Promise.all([
    parseSessionJsonl(path),
    jsonlMtime(path),
  ]);
  return { path, messages, mtime };
}
