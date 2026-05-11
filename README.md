# claude-code-shelving

Deliberate context-shelving for Claude Code. The model invokes a `compress` tool when work is settled enough to be summary-only; a proxy substitutes the registered summary for the original content on subsequent API requests; the session's source-of-truth JSONL stays untouched.

**Status:** Stage 1 working end-to-end and validated against real CC sessions. 106 passing tests including E2E proxy + cache stability and regressions for harness-injected reminders, `tool_use` metadata drift, and tool_use anchors embedded in larger multi-block messages. The canonical design document lives at `field-guide/shared-space/shelving-design.md` during development.

## Architecture

Two coordinated components:

- **MCP server** (`src/mcp/`) — exposes `compress` / `decompress` / `recompress` / `list_compressions` / `start_arc` / `compress_arc` as model-callable tools. Reads from and writes to the registry.
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

Two pieces need to be wired up: the MCP server (so the model can call `compress` and friends) and the proxy (so substitutions actually reach the API).

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

CC reads this on session startup and spawns the MCP server as a child process. The server inherits `CLAUDE_CODE_SESSION_ID` from CC's environment, so tool calls don't need to pass `session_id` explicitly.

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

Matching strategies, in preference order: exact phrase → all words within an arc → any word. Output includes first/last UUIDs, full UUID list, turn count, estimated tokens, and previews. For tool-only turns where text is unavailable, previews fall back to type tags like `[user · tool_result]`.

The model uses this to find candidate boundaries, then confirms them by inspecting context, then calls `compress`. Inspection-as-judgment stays with the model; inspection-as-mechanics is delegated.

**Manual fallback.** When `find-arc` doesn't fit (no clear topic phrase, complex boundaries):

```bash
ls ~/.claude/projects/                                 # find project slug
head -20 ~/.claude/projects/<slug>/<session-id>.jsonl  # inspect entries
```

Each entry has a `uuid` field. The model picks the UUIDs it wants to compress (typically a contiguous range of settled work).

### Compressing

Through the `compress` tool (MCP):

```json
{
  "compressed_uuids": ["uuid-1", "uuid-2", "uuid-3", "..."],
  "summary": "What the model wants to preserve as the model's own voice.",
  "focus": "Optional: what this summary preserved (e.g., 'auth design decisions')"
}
```

Returns a `block_id`. On the next API request, the proxy will substitute the summary for the anchor message (first UUID) and drop the rest of the range.

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
| `CLAUDE_CODE_SESSION_ID` | (set by CC) | Default session for MCP tool calls when not passed explicitly |

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
# Expected: 106 passing

# 3. From inside a CC session with the MCP server registered, ask the model
#    to call list_compressions. It should return an empty blocks array.
```

## Stage 1 scope

What's implemented:
- `compress`, `decompress`, `recompress`, `list_compressions` MCP tools
- `start_arc` / `compress_arc` MCP tools for bookmark-based range capture (label a starting point, do work, compress the labeled range without enumerating UUIDs)
- `find-arc` CLI for assistive boundary discovery (mechanical search; model decides)
- Range-based compress (model provides explicit UUID list)
- Model-authored summaries (no proxy-side summarization)
- Cache-stable proxy substitution
- Content-normalized matching: tolerates JSONL/API drift (thinking blocks, trailing newlines, harness-injected `<system-reminder>` on `tool_result`, `caller` metadata on `tool_use`). See `src/proxy/transform.ts` for the canonicalization invariant.
- Fragment-level anchor matching: when an anchor `tool_use` lives inside a larger assistant message (with thinking and text alongside), substitution happens in place — surrounding content is preserved.
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
