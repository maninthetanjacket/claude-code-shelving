import { findLatestSessionJsonlForProjectDir } from "../proxy/jsonl.js";

/**
 * Lightweight runtime validation for MCP tool inputs.
 *
 * The MCP SDK validates against the JSON Schema in tool definitions, but
 * we add explicit checks here to produce helpful error messages and to
 * defend against any schema-validation gaps.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} must be nonempty`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string): string {
  const s = requireString(value, field);
  if (s.trim().length === 0) {
    throw new ValidationError(`${field} must contain non-whitespace characters`);
  }
  return s;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} must contain at least one element`);
  }
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw new ValidationError(`${field}[${i}] must be a nonempty string`);
    }
  }
  return value as string[];
}

export function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return value;
}

export function optionalNonNegativeInt(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
  return value;
}

export function optionalPositiveInt(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePositiveInt(value, field);
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string if provided`);
  }
  return value;
}

export function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(value, field);
}

/**
 * Resolve session_id from explicit argument, falling back to the
 * CLAUDE_CODE_SESSION_ID environment variable. If that is absent, fall back
 * to the most recently modified transcript for CLAUDE_PROJECT_DIR.
 */
export async function resolveSessionIdArg(value: unknown): Promise<string> {
  if (typeof value === "string" && value.length > 0) return value;

  const fromEnv = process.env["CLAUDE_CODE_SESSION_ID"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

  const projectDir = process.env["CLAUDE_PROJECT_DIR"];
  if (typeof projectDir === "string" && projectDir.length > 0) {
    const latest = await findLatestSessionJsonlForProjectDir(projectDir);
    if (latest !== null) return latest.sessionId;
  }

  throw new ValidationError(
    "session_id is required (pass explicitly, set CLAUDE_CODE_SESSION_ID, or run under Claude Code with CLAUDE_PROJECT_DIR pointing at a project with session transcripts)",
  );
}
