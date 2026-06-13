/**
 * session-map: visualize a Claude Code session by time-grouped token occupancy,
 * to target ranges for shelving.
 *
 * Parses a session JSONL, groups turns into "sittings" by inter-turn time gap,
 * and reports per-group token occupancy (with ASCII bars), a tool histogram,
 * and an extractive summary line. Optionally emits an *inert* Block scaffold
 * (active: false, placeholder summary) for a chosen group — a planning artifact
 * whose turn range lines up 1:1 with what the `compress` MCP tool expects.
 *
 * The tool does not decide what to shelve and does not author summaries; it
 * surfaces structure. Turn numbers are 1-indexed positions in the collapsed
 * UUID stream, identical to compress's start_turn/end_turn.
 *
 * Usage:
 *   session-map <session-id> [--gap-minutes N] [--format text|json]
 *               [--emit-block GROUP] [--out PATH]
 */

import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { findSessionJsonl, parseSessionJsonl } from "../proxy/jsonl.js";
import type { JsonlMessage } from "../proxy/transform.js";
import { countContentTokens } from "../shared/token-count.js";
import type { Block } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Turn model
// ---------------------------------------------------------------------------

/**
 * One collapsed turn: all consecutive messages sharing a UUID, plus its
 * 1-indexed turn number (matching compress's collapsed-stream indexing),
 * summed token occupancy, role, timestamp, and source messages.
 */
export interface Turn {
  turn: number;
  uuid: string;
  role: "user" | "assistant";
  ts: string | null;
  tokens: number;
  messages: JsonlMessage[];
}

/**
 * Build the collapsed turn list. Consecutive messages with the same UUID
 * (e.g. an attachment that parseSessionJsonl expands into two JsonlMessages)
 * collapse into a single turn, matching collapseConsecutiveDuplicates in the
 * proxy/MCP. Token occupancy is summed over all source messages of the turn so
 * group totals equal sum(countContentTokens) over the message range — the same
 * semantics compress uses for estimated_tokens.
 */
export function buildTurns(
  messages: JsonlMessage[],
  timestamps: Map<string, string>,
): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.uuid === m.uuid) {
      last.messages.push(m);
      last.tokens += countContentTokens(m.content);
      continue;
    }
    turns.push({
      turn: turns.length + 1,
      uuid: m.uuid,
      role: m.role,
      ts: timestamps.get(m.uuid) ?? null,
      tokens: countContentTokens(m.content),
      messages: [m],
    });
  }
  return turns;
}

/** Read the raw JSONL once to map uuid -> first-seen ISO timestamp. */
export async function readTimestamps(path: string): Promise<Map<string, string>> {
  const raw = await readFile(path, "utf-8");
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const uuid = e["uuid"];
    const ts = e["timestamp"];
    if (typeof uuid === "string" && typeof ts === "string" && !map.has(uuid)) {
      map.set(uuid, ts);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface Group {
  group: number;
  start_turn: number;
  end_turn: number;
  start_ts: string | null;
  end_ts: string | null;
  duration_min: number | null;
  turn_count: number;
  tokens: number;
  pct: number;
  roles: { user: number; assistant: number };
  tools: Array<{ name: string; count: number }>;
  summary: string;
}

/**
 * Group consecutive turns into sittings: a new group starts whenever the gap
 * between a turn's timestamp and the previous timestamped turn exceeds
 * gapMinutes. Turns without a timestamp inherit the current group.
 */
export function groupTurns(turns: Turn[], gapMinutes: number): Group[] {
  if (turns.length === 0) return [];
  const gapMs = gapMinutes * 60_000;
  const totalTokens = turns.reduce((s, t) => s + t.tokens, 0);

  const clusters: Turn[][] = [];
  let current: Turn[] = [];
  let lastTime: number | null = null;

  for (const t of turns) {
    const time = t.ts !== null ? Date.parse(t.ts) : null;
    if (
      current.length > 0 &&
      lastTime !== null &&
      time !== null &&
      time - lastTime > gapMs
    ) {
      clusters.push(current);
      current = [];
    }
    current.push(t);
    if (time !== null) lastTime = time;
  }
  if (current.length > 0) clusters.push(current);

  return clusters.map((cluster, i) => buildGroup(cluster, i + 1, totalTokens));
}

function buildGroup(cluster: Turn[], groupNum: number, totalTokens: number): Group {
  const first = cluster[0]!;
  const last = cluster[cluster.length - 1]!;
  const tokens = cluster.reduce((s, t) => s + t.tokens, 0);

  const firstTs = cluster.find((t) => t.ts !== null)?.ts ?? null;
  const lastTs = [...cluster].reverse().find((t) => t.ts !== null)?.ts ?? null;
  const durationMin =
    firstTs !== null && lastTs !== null
      ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 60_000)
      : null;

  let userCount = 0;
  let assistantCount = 0;
  const toolCounts = new Map<string, number>();
  for (const turn of cluster) {
    if (turn.role === "user") userCount++;
    else assistantCount++;
    for (const m of turn.messages) {
      for (const name of toolUseNames(m.content)) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      }
    }
  }
  const tools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    group: groupNum,
    start_turn: first.turn,
    end_turn: last.turn,
    start_ts: firstTs,
    end_ts: lastTs,
    duration_min: durationMin,
    turn_count: cluster.length,
    tokens,
    pct: totalTokens > 0 ? tokens / totalTokens : 0,
    roles: { user: userCount, assistant: assistantCount },
    tools,
    summary: extractiveSummary(cluster, tools),
  };
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function toolUseNames(content: string | unknown[]): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use" && typeof b["name"] === "string") {
      names.push(b["name"]);
    }
  }
  return names;
}

/** Visible text of a message, with <thinking> blocks stripped. */
function visibleText(m: JsonlMessage): string {
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
        parts.push(b["text"]);
      }
    }
    raw = parts.join("\n");
  }
  return raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

function truncate(text: string, n: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= n) return cleaned;
  return `${cleaned.slice(0, n - 1)}…`;
}

/**
 * A cheap, no-LLM summary line for a group: the first user-message preview
 * (the ask that started the sitting) plus the dominant tools. Explicitly not a
 * shelving summary — that stays the model's job at compress time.
 */
function extractiveSummary(cluster: Turn[], tools: Array<{ name: string; count: number }>): string {
  let prompt = "";
  for (const turn of cluster) {
    if (turn.role !== "user") continue;
    for (const m of turn.messages) {
      const text = visibleText(m);
      // Skip tool_result-only and system-reminder noise.
      if (text.length > 0 && !text.startsWith("<system-reminder>")) {
        prompt = truncate(text, 80);
        break;
      }
    }
    if (prompt.length > 0) break;
  }
  const toolStr = tools
    .slice(0, 4)
    .map((t) => `${t.name}×${t.count}`)
    .join(" ");
  const parts: string[] = [];
  if (toolStr.length > 0) parts.push(`tools: ${toolStr}`);
  if (prompt.length > 0) parts.push(`"${prompt}"`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Block scaffold
// ---------------------------------------------------------------------------

export const SCAFFOLD_PLACEHOLDER =
  "[PLACEHOLDER — author a first-person summary before activating]";

/**
 * Build an inert Block scaffold for a group: active:false, placeholder summary,
 * computed uuids and original_tokens. block_id is 0 (assigned at registration).
 * This intentionally does NOT run tool-pair closure (closeRangeForToolPairs) —
 * the compress MCP tool owns that. Treat the scaffold as a planning artifact.
 */
export function buildScaffold(group: Group, turns: Turn[]): Block {
  const rangeTurns = turns.filter(
    (t) => t.turn >= group.start_turn && t.turn <= group.end_turn,
  );
  const uuids = rangeTurns.map((t) => t.uuid);
  return {
    block_id: 0,
    created_at: new Date().toISOString(),
    kind: "compression",
    active: false,
    anchor_uuid: uuids[0] ?? "",
    compressed_uuids: uuids,
    summary: `${group.summary}\n\n${SCAFFOLD_PLACEHOLDER}`,
    original_tokens: group.tokens,
    summary_tokens: 0,
    focus: group.summary,
    parent_block_id: null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtWhen(ts: string | null, durationMin: number | null): string {
  if (ts === null) return "(no time)";
  const d = new Date(ts);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const dur =
    durationMin === null
      ? ""
      : durationMin >= 60
        ? ` (${(durationMin / 60).toFixed(1)}h)`
        : ` (${durationMin}m)`;
  return `${mon}${day} ${hh}:${mm}${dur}`;
}

function bar(pct: number, maxPct: number, width = 24): string {
  if (maxPct <= 0) return "";
  const filled = Math.round((pct / maxPct) * width);
  return "█".repeat(Math.max(0, filled));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function renderText(groups: Group[], sessionId: string, gapMinutes: number): string {
  if (groups.length === 0) return `No turns found in session ${sessionId}.\n`;
  const totalTokens = groups.reduce((s, g) => s + g.tokens, 0);
  const totalTurns = groups.reduce((s, g) => s + g.turn_count, 0);
  const maxPct = Math.max(...groups.map((g) => g.pct));

  const lines: string[] = [];
  lines.push(
    `session ${sessionId} · ${totalTurns} turns · ~${fmtTokens(totalTokens)} tokens · ${groups.length} groups (gap > ${gapMinutes}m)\n`,
  );
  lines.push(
    `${pad("GRP", 4)}${pad("TURNS", 13)}${pad("WHEN", 20)}${padStart("TOKENS", 8)}${padStart("%", 5)}  BAR`,
  );
  for (const g of groups) {
    const range = `${g.start_turn}–${g.end_turn}`;
    lines.push(
      `${pad(String(g.group), 4)}${pad(range, 13)}${pad(fmtWhen(g.start_ts, g.duration_min), 20)}` +
        `${padStart(fmtTokens(g.tokens), 8)}${padStart(`${Math.round(g.pct * 100)}%`, 5)}  ${bar(g.pct, maxPct)}`,
    );
    if (g.summary.length > 0) lines.push(`      ${g.summary}`);
  }
  lines.push("");
  lines.push(
    `${pad("TOT", 4)}${pad(`${totalTurns} turns`, 13)}${pad("", 20)}${padStart(fmtTokens(totalTokens), 8)}${padStart("100%", 5)}`,
  );
  return lines.join("\n") + "\n";
}

export function renderJson(groups: Group[], sessionId: string, gapMinutes: number): string {
  const totalTokens = groups.reduce((s, g) => s + g.tokens, 0);
  const totalTurns = groups.reduce((s, g) => s + g.turn_count, 0);
  return (
    JSON.stringify(
      {
        session_id: sessionId,
        total_turns: totalTurns,
        total_tokens: totalTokens,
        gap_minutes: gapMinutes,
        groups: groups.map((g) => ({
          group: g.group,
          start_turn: g.start_turn,
          end_turn: g.end_turn,
          start_ts: g.start_ts,
          end_ts: g.end_ts,
          duration_min: g.duration_min,
          turn_count: g.turn_count,
          tokens: g.tokens,
          pct: Number(g.pct.toFixed(4)),
          roles: g.roles,
          tools: g.tools,
          summary: g.summary,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  sessionId: string;
  gapMinutes: number;
  format: "text" | "json";
  emitBlock: number | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let gapMinutes = 30;
  let format: "text" | "json" = "text";
  let emitBlock: number | null = null;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gap-minutes") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--gap-minutes requires a value");
      gapMinutes = Number.parseFloat(v);
      if (Number.isNaN(gapMinutes) || gapMinutes <= 0) {
        throw new Error("--gap-minutes must be a positive number");
      }
    } else if (a === "--format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") throw new Error("--format must be 'text' or 'json'");
      format = v;
    } else if (a === "--emit-block") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--emit-block requires a group number");
      emitBlock = Number.parseInt(v, 10);
      if (Number.isNaN(emitBlock) || emitBlock < 1) {
        throw new Error("--emit-block must be a positive group number");
      }
    } else if (a === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--out requires a path");
      out = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  if (positional.length < 1) throw new Error("usage: session-map <session-id> [options]");
  return { sessionId: positional[0]!, gapMinutes, format, emitBlock, out };
}

function printHelp(): void {
  process.stdout.write(`session-map — time-grouped token map of a session, for targeting shelving.

Usage:
  session-map <session-id> [options]

Options:
  --gap-minutes N   Start a new group when the inter-turn gap exceeds N minutes (default: 30)
  --format F        text | json (default: text)
  --emit-block G    Emit an inert Block scaffold (active:false) for group G
  --out PATH        Where to write the scaffold (default: ./shelve-block-group<G>.json)
  --help, -h        Show this help

Turn numbers are 1-indexed positions in the collapsed UUID stream — directly
usable as compress's start_turn / end_turn. The tool does not author summaries
or activate blocks; it surfaces structure.
`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("run with --help for usage\n");
    process.exit(2);
  }

  const path = await findSessionJsonl(args.sessionId);
  if (path === null) {
    process.stderr.write(`error: no session JSONL found for id ${args.sessionId}\n`);
    process.exit(1);
  }

  const [messages, timestamps] = await Promise.all([
    parseSessionJsonl(path),
    readTimestamps(path),
  ]);
  if (messages.length === 0) {
    process.stderr.write(`error: session JSONL at ${path} has no user/assistant messages\n`);
    process.exit(1);
  }

  const turns = buildTurns(messages, timestamps);
  const groups = groupTurns(turns, args.gapMinutes);

  if (args.emitBlock !== null) {
    const group = groups.find((g) => g.group === args.emitBlock);
    if (group === undefined) {
      process.stderr.write(
        `error: group ${args.emitBlock} out of range (1-${groups.length})\n`,
      );
      process.exit(1);
    }
    const scaffold = buildScaffold(group, turns);
    const outPath = args.out ?? `./shelve-block-group${args.emitBlock}.json`;
    await writeFile(outPath, JSON.stringify(scaffold, null, 2) + "\n");
    process.stdout.write(
      `Wrote inert scaffold for group ${group.group} (turns ${group.start_turn}–${group.end_turn}, ` +
        `~${fmtTokens(group.tokens)} tokens) to ${outPath}\n` +
        `It is active:false with a placeholder summary. To actually shelve, hand\n` +
        `start_turn=${group.start_turn} end_turn=${group.end_turn} to the compress MCP tool\n` +
        `(which runs tool-pair closure and lets you author the summary), or finish\n` +
        `the summary in the file and register it deliberately.\n`,
    );
    return;
  }

  const output =
    args.format === "json"
      ? renderJson(groups, args.sessionId, args.gapMinutes)
      : renderText(groups, args.sessionId, args.gapMinutes);
  process.stdout.write(output);
}

import { pathToFileURL } from "node:url";

// Only run the CLI when executed directly, not when imported by tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
