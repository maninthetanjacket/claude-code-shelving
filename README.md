# claude-code-shelving

Deliberate context-shelving for Claude Code. The model can invoke `compress` to substitute a summary for settled work, or `place` to substitute authored content at a single anchor turn; the proxy applies the registered substitution on subsequent API requests; the session's source-of-truth JSONL stays untouched.

**Status:** Stage 1 working end-to-end and validated against real CC sessions. 132 passing tests including E2E proxy + cache stability and regressions for harness-injected reminders, `tool_use` metadata drift, tool_use anchors embedded in larger multi-block messages, tool-pair ID matching as a backstop when content bytes drift, placement refusal on unclosed tool pairs, and calibrated token estimation. The proxy injects `[turn N]` markers at the start of assistant responses so the model can address ranges by turn number; `compress` accepts UUID-list, phrase-pair, or turn-range selection, and `place` accepts turn / UUID / unique-phrase anchor selection. The canonical design document lives at `field-guide/shared-space/shelving-design.md` during development.

## Architecture

Two coordinated components:

- **MCP server** (`src/mcp/`) — exposes `compress` / `place` / `decompress` / `recompress` / `list_compressions` / `start_arc` / `compress_arc` as model-callable tools. Reads from and writes to the registry.
- **Proxy** (`src/proxy/`) — HTTP server between Claude Code and the Anthropic API. Reads the registry on each request and applies cache-stable substitutions.

They communicate via a file-based registry under `~/.claude/shelving/<session-id>/`. They never talk to each other directly; both just read/write the same JSON files.

## Practice discipline

This system is designed for **deliberate** shelving, not automatic compression. The prompt and tool surface intentionally avoid:

- Threshold-based "must" or "critical" language
- Compulsion or responsibility-framing
- Auto-compression based on heuristics

The model decides when to compress. The strongest acceptable nudge (if implemented at all) is informational. See `field-guide/shared-space/shelving-design.md` § "Practice discipline" for the empirical justification.

## Install

Requires Node.js 18+ and Claude Code.

```bash
git clone <repo-url> claude-code-shelving
cd claude-code-shelving
npm install
npm run build
```

`npm run build` emits compiled JS to `dist/` for production use. During development you can also run sources directly via `tsx` (no build step) — `npm run mcp` and `npm run proxy` use this path.

## Configure

Two pieces need to be wired up: the MCP server (so the model can call `compress`, `place`, and friends) and the proxy (so substitutions actually reach the API).

### 1. Register the MCP server with Claude Code

Add a `.mcp.json` to your project root, or merge into `~/.claude/.mcp.json` for global use:

```json
{
  "mcpServers": {
    "shelving": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-shelving/dist/mcp/server.js"]
    }
  }
}
```

For development without building, use `tsx` instead:

```json
{
  "mcpServers": {
    "shelving": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-code-shelving/src/mcp/server.ts"]
    }
  }
}
```

CC reads this on session startup and spawns the MCP server as a child process. If `CLAUDE_CODE_SESSION_ID` is present, the shelving server uses it directly. If it is absent, the server falls back to the most recently modified session transcript under the current `CLAUDE_PROJECT_DIR`.

### 2. Start the proxy

The proxy is a separate process. Run it before launching CC:

```bash
# Default: listens on 127.0.0.1:9802, forwards to api.anthropic.com
node /absolute/path/to/claude-code-shelving/dist/proxy/server.js
```

Or via the dev script:

```bash
cd claude-code-shelving && npm run proxy
```

For long-running use, run as a service (systemd / launchd / nohup) — see "Running as a service" below.

### 3. Tell Claude Code to use the proxy

Set `ANTHROPIC_BASE_URL` before launching CC:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude
```

Verify the proxy is up first:

```bash
curl http://127.0.0.1:9802/health
# {"status":"ok","upstream":"https://api.anthropic.com/"}
```

### 4. Chaining with cache-fix-proxy (optional)

If you're using `cache-fix-proxy` (recommended for subscription users), chain the shelving proxy through it:

```bash
# cache-fix-proxy runs on 9801 (default)
# shelving proxy runs on 9802 and forwards to cache-fix-proxy
SHELVING_PROXY_UPSTREAM=http://127.0.0.1:9801 \
  node /path/to/claude-code-shelving/dist/proxy/server.js

# Then point CC at the shelving proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude
```

Order matters: shelving substitutes first (smaller request), cache-fix normalizes the result for caching, Anthropic receives the final form.

## Use with an existing session

CC reads `ANTHROPIC_BASE_URL` at startup. To insert the proxy into an existing conversation:

```bash
# 1. Start the proxy (if not already running)
node /path/to/claude-code-shelving/dist/proxy/server.js &

# 2. Resume the session through the proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude --resume <session-id>
```

CC reads the session JSONL, restores the full conversation, and now sends API requests through the proxy. The MCP tools become available immediately. Run `list_compressions` to confirm the registry is empty (or shows previous compressions if any exist).

The session UUID is preserved across `--resume`, so any registry state under `~/.claude/shelving/<session-id>/` continues to apply.

## Usage

### Finding messages to compress

Two paths: assistive CLI for the common case, manual JSONL inspection for everything else.

**Assistive CLI: `find-arc`.** Surfaces candidate UUID ranges given a topic phrase. Doesn't decide what to shelve — narrows the search space.

```bash
node dist/cli/find-arc.js <session-id> "topic phrase" [options]
```

Options:
- `--limit N` — show top-N candidates (default: 5)
- `--context M` — expand each arc by up to M turns on each side (default: 1)
- `--format text|json` — output format (default: text)

Matching strategies, in preference order: exact phrase → all words within an arc → any word. Output includes first/last UUIDs, full UUID list, turn count, estimated tokens (calibrated — see [Token estimation](#token-estimation)), and previews. For tool-only turns where text is unavailable, previews fall back to type tags like `[user · tool_result]`.

The model uses this to find candidate boundaries, then confirms them by inspecting context, then calls `compress`. Inspection-as-judgment stays with the model; inspection-as-mechanics is delegated.

**Manual fallback.** When `find-arc` doesn't fit (no clear topic phrase, complex boundaries):

```bash
ls ~/.claude/projects/                                 # find project slug
head -20 ~/.claude/projects/<slug>/<session-id>.jsonl  # inspect entries
```

Each entry has a `uuid` field. The model picks the UUIDs it wants to compress (typically a contiguous range of settled work).

### Compressing

The `compress` tool accepts three interchangeable ways to specify the range. Pick whichever fits how the model knows the range it wants to shelve.

**Phrase-pair selection.** Address the range by distinctive substrings from its start and end. Typical for arcs whose boundaries are easier to recall as content than as numbers.

```json
{
  "first_phrase": "Codex had added a fix to ensure tool calls would get matched by ID",
  "last_phrase": "Three commits today, all merged",
  "summary": "What the model wants to preserve as the model's own voice.",
  "focus": "Optional: what this summary preserved",
  "preview_only": true
}
```

With `preview_only: true`, the server returns the resolved turn range, matched anchor/end snippets, turn count, estimated tokens, and the full UUID list — without compressing. Inspect, then re-call with `confirm: true` (and `preview_only` removed or false) to perform the compression. If pair-closure widens the resolved range to keep a `tool_use` and its `tool_result` together, preview payloads also include `extended_turns` and `closure_note` so the model can see the adjustment before confirming. `last_phrase` is optional; if omitted, the range extends from `first_phrase` to the latest user message in the JSONL.

**Turn-range selection.** Address the range by turn numbers. The proxy injects `[turn N]\n\n` at the start of each assistant response, so the model can see its own turn numbers in flight.

```json
{
  "start_turn": 996,
  "end_turn": 1030,
  "summary": "...",
  "focus": "..."
}
```

`end_turn` is optional; defaults to the latest user message.

**UUID-list selection.** The original mode. Useful when you've already enumerated the range some other way (e.g., from `find-arc` output or manual JSONL inspection).

```json
{
  "compressed_uuids": ["uuid-1", "uuid-2", "uuid-3", "..."],
  "summary": "...",
  "focus": "..."
}
```

All three modes run a pair-closure pass after resolving the candidate range. If the range includes a `tool_use`, its paired `tool_result` is pulled in too; if the range would begin on a `tool_result`, the range extends backward to include the earlier `tool_use` rather than trimming the selected start away. This keeps tool exchanges structurally closed before compression. All three modes return a `block_id`. On the next API request, the proxy substitutes the summary for the anchor message (first message of the resolved range) and drops the rest. Token-count estimates (`original_tokens`, `summary_tokens`) are optional registry metadata; the server estimates `original_tokens` from JSONL content if omitted (see [Token estimation](#token-estimation)).

### Placement

`place` is the sibling operation to `compress`: mechanically it is a single-turn substitution, but semantically it is not a summary. New authored material enters the model's apparent history at exactly one anchor turn.

Integrity properties for placement are explicit:

- **Deliberate** — the author chooses one anchor by turn number, UUID, or unique phrase match.
- **Previewed** — `preview_only: true` shows the resolved anchor turn, its current content snippet, and the replacement content before anything is written.
- **Reversible** — `decompress` restores the original turn; `recompress` re-applies the placement byte-identically.
- **Registry-marked** — blocks are stored with `kind: "placement"` so listings stay honest about residue versus grafts.

Inline content:

```json
{
  "turn": 412,
  "content": "A cold stone in the pocket, river-smooth and damp.",
  "preview_only": true
}
```

File-backed content:

```json
{
  "anchor_uuid": "uuid-1",
  "content_file": "/absolute/path/to/sensory-stone.txt",
  "confirm": true
}
```

`content` and `content_file` are mutually exclusive. `turn`, `anchor_uuid`, and `phrase` are mutually exclusive. When preview looks right, re-call with `confirm: true` to persist the placement.

Placement is exactly one message. The same tool-pair closure logic used by compression is checked here too, but with a stricter rule: if the chosen anchor would need to auto-extend to keep a `tool_use` and `tool_result` together, `place` refuses rather than widening the range. That way the operation never swallows turns the author did not choose.

### Token estimation

`original_tokens` and `find-arc`'s `estimated_tokens` come from a calibrated estimator in `src/shared/token-count.ts`. The goal is to judge how much *Claude* context a range actually occupies.

The base count uses a real BPE tokenizer (`gpt-tokenizer`, `o200k_base`) over the extracted content of every block — text, thinking, `tool_use` inputs, and `tool_result` bodies. This replaced a `chars / 4` heuristic, which ran ~2× low because shelving content is dominated by JSON, file paths, bash output, and hyphenated UUIDs that tokenize far denser than prose.

A raw o200k count still isn't the target number. Calibrating o200k message tokens against real Anthropic `input_tokens` across ~60 captured requests (two-variable least squares, R² ≈ 0.94) yields a two-term **marginal** model:

```
freed_tokens(range) ≈ Σ_msgs [ 1.42 · o200k(content) + 0.28 · o200k(signature) ]
```

- **`CONTENT_CALIBRATION` (1.42)** — Claude's tokenizer is ~1.4× denser than o200k on this content mix (prose + code + JSON).
- **`SIGNATURE_CALIBRATION` (0.28)** — extended-thinking blocks carry an encrypted `signature` (a large base64 blob, present in every replayed request). It is billed as input, but only ~28% of its tokenized length lands. The signature also tracks the *hidden* raw reasoning behind a turn (it scales with it, r ≈ 0.96), which is why it carries real input weight even though the visible thinking is only a summary.
- The fixed prefix (system prompt + tool schemas, ~30K tokens in the measured config) is deliberately **excluded** — the estimate is marginal, and shelving conversation turns never reclaims the system/tools prefix.

End-to-end the calibrated model predicts real `input_tokens` to within ~1% (median) on the captured traffic. The coefficients were fit on a single session and model: `1.42` (tokenizer density) should generalize; `0.28` (an Anthropic-internal billing/encoding artifact) may drift. Both are isolated, documented constants, easy to re-measure and retune.

### Decompressing

```json
{ "block_id": 1 }
```

The block stays in the registry as `active: false`. Original messages reappear in subsequent requests.

### Recompressing

```json
{ "block_id": 1 }
```

Reactivates a previously decompressed block. The summary text is byte-identical to before, so the cache prefix can be re-cached.

### Listing

```json
{}
```

Returns metadata for all blocks in the current session (active and inactive).

Each listed block includes `kind`, so operators can see whether it is a `compression` or a `placement`.

### Bookmarking a range (alternative to enumerating UUIDs)

For multi-step work where the eventual range isn't known in advance — e.g., reading a chunk of a document, doing exploratory tool calls before knowing what's relevant — bookmark the start, do the work, then compress the bookmarked range without having to look up UUIDs.

**Start an arc** (records a bookmark at the current point):

```json
{ "label": "chunk-3" }
```

The bookmark captures the UUID of the most recent JSONL entry at invocation time (typically the user message that triggered this assistant turn).

**Compress an arc** (resolves the bookmarked range and submits as a Block):

```json
{
  "label": "chunk-3",
  "summary": "What the model wants to preserve as the model's own voice.",
  "focus": "Optional metadata"
}
```

The range spans from the bookmark's anchor UUID to the most recent user message in the JSONL at this call. The current assistant turn (containing any preceding reflection text and the `compress_arc` call itself) is naturally excluded, leaving the reflection visible in the conversation. The bookmark is consumed once compression succeeds.

This is equivalent to `compress` with the resolved UUIDs but doesn't require the model to enumerate them.

## Configuration reference

Proxy:

| Env var | Default | Purpose |
|---------|---------|---------|
| `SHELVING_PROXY_PORT` | `9802` | Listen port |
| `SHELVING_PROXY_BIND` | `127.0.0.1` | Bind address |
| `SHELVING_PROXY_UPSTREAM` | `https://api.anthropic.com` | Upstream URL (chain via another proxy by setting this to its address) |
| `SHELVING_PROXY_LOG_LEVEL` | `info` | One of `silent`, `info`, `debug` |
| `SHELVING_PROXY_DUMP_DIR` | (unset) | If set, dump `<timestamp>.original.json`, `.transformed.json`, `.meta.json` per request for debugging. Useful for replaying failing requests against the transform. |

Both:

| Env var | Default | Purpose |
|---------|---------|---------|
| `CLAUDE_SHELVING_DIR` | `~/.claude/shelving` | Registry root |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | CC session JSONL root (proxy reads to map UUIDs) |
| `CLAUDE_CODE_SESSION_ID` | (optional) | Preferred default session for MCP tool calls when not passed explicitly |
| `CLAUDE_PROJECT_DIR` | (set by CC for MCP stdio servers) | Fallback project root used to infer the latest session transcript when `CLAUDE_CODE_SESSION_ID` is absent |

> **Note on Claude Code MCP env propagation.** As observed in practice, recent Claude Code versions do **not** propagate `CLAUDE_CODE_SESSION_ID` or `CLAUDE_PROJECT_DIR` to spawned MCP stdio child processes. The `session_id` argument is therefore the practical path under CC — passing it explicitly on each call. Other MCP hosts (or wrapper scripts that inject these env vars) can rely on the auto-inference fallback. If CC adds env propagation in the future, the fallback will activate without code changes.

## Running as a service

### Linux (systemd user unit)

`~/.config/systemd/user/shelving-proxy.service`:

```ini
[Unit]
Description=claude-code-shelving proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /absolute/path/to/claude-code-shelving/dist/proxy/server.js
Restart=on-failure
Environment=SHELVING_PROXY_PORT=9802

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now shelving-proxy
```

### macOS / quick manual

```bash
nohup node /path/to/dist/proxy/server.js > /tmp/shelving-proxy.log 2>&1 &
```

## Verifying it works

After install + setup:

```bash
# 1. Proxy health
curl http://127.0.0.1:9802/health
# Expected: {"status":"ok","upstream":"https://api.anthropic.com/"}

# 2. Run tests
cd claude-code-shelving && npm test
# Expected: 120 passing

# 3. From inside a CC session with the MCP server registered, ask the model
#    to call list_compressions. It should return an empty blocks array.
```

## Stage 1 scope

What's implemented:
- `compress`, `place`, `decompress`, `recompress`, `list_compressions` MCP tools
- `start_arc` / `compress_arc` MCP tools for bookmark-based range capture (label a starting point, do work, compress the labeled range without enumerating UUIDs)
- `find-arc` CLI for assistive boundary discovery (mechanical search; model decides)
- Calibrated token estimation (real BPE tokenizer over all block types, calibrated to Claude `input_tokens` with a content-density term and a thinking-signature term; see "Token estimation")
- Range-based compress (model provides explicit UUID list)
- Model-authored summaries (no proxy-side summarization)
- Authored single-turn placements with preview, reversal, and registry-marked `kind`
- Cache-stable proxy substitution
- Content-normalized matching: tolerates JSONL/API drift (thinking blocks, trailing newlines, harness-injected `<system-reminder>` on `tool_result`, `caller` metadata on `tool_use`). See `src/proxy/transform.ts` for the canonicalization invariant.
- Fragment-level anchor matching: when an anchor `tool_use` lives inside a larger assistant message (with thinking and text alongside), substitution happens in place — surrounding content is preserved.
- Tool-pair ID matching as backstop: when content matching fails entirely (drift beyond normalization), `tool_use.id` and `tool_result.tool_use_id` are used to keep both sides of a tool exchange in the same block — prevents orphaned-tool_use errors from asymmetric drops.
- File-based registry under `~/.claude/shelving/<session>/`
- Atomic registry writes; mtime-cached reads in the proxy
- Fail-safe to passthrough on any transform error
- Optional request dumps for debugging (`SHELVING_PROXY_DUMP_DIR`)

What's deferred to later stages:
- Nested blocks (parent_block_id is in schema but always null in v1)
- Auto-compression / heuristic range selection
- Proxy-side summarization
- Native cache-fix-proxy extension (chain via upstream URL for now)
- Optional informational nudges (none implemented; deliberately no-op)

## License

MIT
