/**
 * find-arc: locate candidate UUID ranges in a session JSONL by topic phrase.
 *
 * Assistive tool for shelving — surfaces structure without making decisions.
 * Given a query phrase and session id, returns ranked candidate arcs:
 * contiguous turn ranges where the phrase appears, with boundary previews
 * and rough token estimates.
 *
 * The CLI does not decide what to shelve. It narrows the search space.
 * The author confirms boundaries, decides whether the arc is settled,
 * and writes the summary.
 *
 * Usage:
 *   find-arc <session-id> <query> [--limit N] [--context M] [--format json]
 *
 * Defaults:
 *   --limit 5    Show top-N candidates
 *   --context 3  Walk at most N turns past last hit when expanding boundaries
 *   --format text  text | json
 */

import { findSessionJsonl, parseSessionJsonl } from "../proxy/jsonl.js";
import type { JsonlMessage } from "../proxy/transform.js";

interface Candidate {
  first_uuid: string;
  last_uuid: string;
  uuids: string[];
  turn_count: number;
  estimated_tokens: number;
  first_preview: string;
  last_preview: string;
  match_count: number;
  match_kind: "phrase" | "all-words" | "any-word";
}

interface Args {
  sessionId: string;
  query: string;
  limit: number;
  context: number;
  format: "text" | "json";
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let limit = 5;
  let context = 1;
  let format: "text" | "json" = "text";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      i++;
      const v = argv[i];
      if (v === undefined) throw new Error("--limit requires a value");
      limit = Number.parseInt(v, 10);
      if (Number.isNaN(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
    } else if (a === "--context") {
      i++;
      const v = argv[i];
      if (v === undefined) throw new Error("--context requires a value");
      context = Number.parseInt(v, 10);
      if (Number.isNaN(context) || context < 0) {
        throw new Error("--context must be a non-negative integer");
      }
    } else if (a === "--format") {
      i++;
      const v = argv[i];
      if (v !== "text" && v !== "json") {
        throw new Error("--format must be 'text' or 'json'");
      }
      format = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  if (positional.length < 2) {
    throw new Error("usage: find-arc <session-id> <query> [options]");
  }

  // Query may have multiple words; join all positional args after session id.
  const sessionId = positional[0]!;
  const query = positional.slice(1).join(" ");

  return { sessionId, query, limit, context, format };
}

function printHelp(): void {
  process.stdout.write(`find-arc — locate candidate UUID ranges in a session JSONL.

Usage:
  find-arc <session-id> <query> [options]

Options:
  --limit N      Show top-N candidates (default: 5)
  --context M    Walk at most M turns past last hit when expanding (default: 1)
  --format F     text | json (default: text)
  --help, -h     Show this help

The query may be a phrase or a few keywords. Matching strategies, in order
of preference: exact phrase, all words within an arc, any word.

Output is candidate ranges. The tool does not decide what to shelve —
confirm boundaries and write summaries yourself.
`);
}

/**
 * Extract text from a JsonlMessage.
 *
 * `stripThinking` controls whether `<thinking>...</thinking>` blocks are
 * removed. For previews we strip them (the reader cares about visible
 * content); for matching we keep them (the topic phrase might appear
 * inside thinking).
 */
function messageText(m: JsonlMessage, stripThinking = false): string {
  const c = m.content;
  let raw: string;
  if (typeof c === "string") {
    raw = c;
  } else if (!Array.isArray(c)) {
    return "";
  } else {
    const parts: string[] = [];
    for (const block of c) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        parts.push(b["text"] as string);
      }
    }
    raw = parts.join("\n");
  }
  if (!stripThinking) return raw;
  // Remove <thinking>...</thinking> blocks. Use [\s\S] to span newlines.
  return raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

/**
 * Describe a message for preview purposes when no text is available.
 * Returns a tag like "[user · tool_result]" or "[assistant · tool_use: Bash]".
 */
function messageTag(m: JsonlMessage): string {
  const c = m.content;
  if (typeof c === "string") {
    // String content with no text — empty user message
    return `[${m.role} · empty]`;
  }
  if (!Array.isArray(c)) return `[${m.role}]`;
  const types: string[] = [];
  for (const block of c) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const t = b["type"];
    if (typeof t === "string") {
      if (t === "tool_use" && typeof b["name"] === "string") {
        types.push(`tool_use:${b["name"] as string}`);
      } else {
        types.push(t);
      }
    }
  }
  if (types.length === 0) return `[${m.role}]`;
  return `[${m.role} · ${types.join(", ")}]`;
}

/** Get a preview, falling back to a type tag if no text content exists. */
function messagePreview(m: JsonlMessage, n = 80): string {
  const text = messageText(m, true); // strip thinking for previews
  if (text.trim().length > 0) return preview(text, n);
  return messageTag(m);
}

/** Rough token estimate: 4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate to N chars with ellipsis. */
function preview(text: string, n = 80): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= n) return cleaned;
  return `${cleaned.slice(0, n - 1)}…`;
}

interface Hit {
  index: number;
  matchedTerms: string[];
}

/**
 * Find indices of messages where the query matches.
 *
 * Strategy:
 *   1. Exact phrase (case-insensitive). If any hit, return only those.
 *   2. All words present in same message (case-insensitive).
 *   3. Any word present (last resort).
 */
function findHits(
  messages: JsonlMessage[],
  query: string,
): { hits: Hit[]; kind: "phrase" | "all-words" | "any-word" } {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 0);

  // Strategy 1: exact phrase
  const phraseHits: Hit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]!).toLowerCase();
    if (text.includes(lower)) {
      phraseHits.push({ index: i, matchedTerms: [lower] });
    }
  }
  if (phraseHits.length > 0) {
    return { hits: phraseHits, kind: "phrase" };
  }

  if (words.length === 0) {
    return { hits: [], kind: "phrase" };
  }

  // Strategy 2: all words in same message
  const allWordsHits: Hit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]!).toLowerCase();
    const matched = words.filter((w) => text.includes(w));
    if (matched.length === words.length) {
      allWordsHits.push({ index: i, matchedTerms: matched });
    }
  }
  if (allWordsHits.length > 0) {
    return { hits: allWordsHits, kind: "all-words" };
  }

  // Strategy 3: any word
  const anyWordHits: Hit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]!).toLowerCase();
    const matched = words.filter((w) => text.includes(w));
    if (matched.length > 0) {
      anyWordHits.push({ index: i, matchedTerms: matched });
    }
  }
  return { hits: anyWordHits, kind: "any-word" };
}

/**
 * Cluster hits into contiguous arcs.
 *
 * Two hits belong to the same arc if they're within `context` non-hit
 * messages of each other. After clustering, expand each arc by up to
 * `context` messages backward (to include the user-message that initiated
 * the topic) and forward (to include the closing assistant response).
 */
function clusterIntoArcs(
  hits: Hit[],
  totalMessages: number,
  context: number,
): Array<{ start: number; end: number; hits: Hit[] }> {
  if (hits.length === 0) return [];

  const arcs: Array<{ start: number; end: number; hits: Hit[] }> = [];
  let current: { start: number; end: number; hits: Hit[] } = {
    start: hits[0]!.index,
    end: hits[0]!.index,
    hits: [hits[0]!],
  };

  for (let i = 1; i < hits.length; i++) {
    const h = hits[i]!;
    const gap = h.index - current.end;
    if (gap <= context + 1) {
      // Extend current arc
      current.end = h.index;
      current.hits.push(h);
    } else {
      arcs.push(current);
      current = { start: h.index, end: h.index, hits: [h] };
    }
  }
  arcs.push(current);

  // Expand each arc by `context` on both sides, clamped to message bounds.
  for (const arc of arcs) {
    arc.start = Math.max(0, arc.start - context);
    arc.end = Math.min(totalMessages - 1, arc.end + context);
  }

  return arcs;
}

function buildCandidate(
  arc: { start: number; end: number; hits: Hit[] },
  messages: JsonlMessage[],
  kind: "phrase" | "all-words" | "any-word",
): Candidate {
  const slice = messages.slice(arc.start, arc.end + 1);
  const uuids = slice.map((m) => m.uuid);
  let totalChars = 0;
  for (const m of slice) {
    totalChars += messageText(m).length;
  }
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;

  return {
    first_uuid: first.uuid,
    last_uuid: last.uuid,
    uuids,
    turn_count: slice.length,
    estimated_tokens: Math.ceil(totalChars / 4),
    first_preview: messagePreview(first),
    last_preview: messagePreview(last),
    match_count: arc.hits.length,
    match_kind: kind,
  };
}

function rankCandidates(candidates: Candidate[]): Candidate[] {
  // Sort by match_count desc, then by turn_count desc (longer arcs first
  // when match counts tie — they're more likely to be the substantive one).
  return [...candidates].sort((a, b) => {
    if (b.match_count !== a.match_count) return b.match_count - a.match_count;
    return b.turn_count - a.turn_count;
  });
}

function formatText(candidates: Candidate[], query: string, totalMessages: number): string {
  if (candidates.length === 0) {
    return `No matches for "${query}" in ${totalMessages} messages.\n`;
  }

  const lines: string[] = [];
  lines.push(`${candidates.length} candidate${candidates.length === 1 ? "" : "s"} for "${query}":\n`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    lines.push(`[${i + 1}] ${c.match_kind} match · ${c.match_count} hit${c.match_count === 1 ? "" : "s"} · ${c.turn_count} turns · ~${c.estimated_tokens} tokens`);
    lines.push(`    first: ${c.first_uuid}`);
    lines.push(`           ${c.first_preview}`);
    lines.push(`    last:  ${c.last_uuid}`);
    lines.push(`           ${c.last_preview}`);
    lines.push(`    uuids: ${c.uuids.length} total`);
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.stderr.write("run with --help for usage\n");
    process.exit(2);
  }

  const path = await findSessionJsonl(args.sessionId);
  if (path === null) {
    process.stderr.write(`error: no session JSONL found for id ${args.sessionId}\n`);
    process.exit(1);
  }

  const messages = await parseSessionJsonl(path);
  if (messages.length === 0) {
    process.stderr.write(`error: session JSONL at ${path} has no user/assistant messages\n`);
    process.exit(1);
  }

  const { hits, kind } = findHits(messages, args.query);
  const arcs = clusterIntoArcs(hits, messages.length, args.context);
  const candidates = arcs.map((arc) => buildCandidate(arc, messages, kind));
  const ranked = rankCandidates(candidates).slice(0, args.limit);

  if (args.format === "json") {
    process.stdout.write(JSON.stringify({ query: args.query, total_messages: messages.length, candidates: ranked }, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(ranked, args.query, messages.length));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
