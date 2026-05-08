import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "./types.js";

/**
 * Path resolution for the shelving registry.
 *
 * Layout:
 *   ~/.claude/shelving/                       (root)
 *     <session-id>/                           (per-session directory)
 *       <block-id>.json                       (one file per block)
 *
 * The root can be overridden via the `CLAUDE_SHELVING_DIR` environment
 * variable, primarily for testing. When unset, defaults to ~/.claude/shelving.
 */

export function shelvingRoot(): string {
  const override = process.env["CLAUDE_SHELVING_DIR"];
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".claude", "shelving");
}

export function sessionDir(sessionId: SessionId): string {
  return join(shelvingRoot(), sessionId);
}

export function blockPath(sessionId: SessionId, blockId: number): string {
  return join(sessionDir(sessionId), `${blockId}.json`);
}

/** Temp filename used by atomic writes (rename-after-write). */
export function blockTempPath(sessionId: SessionId, blockId: number): string {
  return join(sessionDir(sessionId), `${blockId}.json.tmp`);
}
