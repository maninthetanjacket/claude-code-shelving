# Observed Claude Code Normalization Rules

This note captures the JSONL-to-API transformations we have confirmed while hardening the shelving proxy. It is meant as a handoff document for future sessions.

## Why this exists

The shelving proxy reads session JSONL, but it must rewrite live `/v1/messages` requests. Claude Code does not send those requests as a byte-for-byte replay of stored transcript entries. It normalizes, merges, and sometimes reshapes content before the API call.

Most proxy bugs we have hit came from assuming:

- one JSONL message maps to one API message
- content block shapes are stable between storage and wire
- tool/media blocks stay where they were originally recorded

Those assumptions are false.

## Evidence sources

These rules are based on:

- Real original/transformed proxy dumps under `/tmp/shelving`
- Real session JSONL for session `d1e07f5e-8d0b-4c28-beb6-a4d24d4ad967`
- Older Claude Code source under `~/claude-code`, especially:
  - `src/utils/messages.ts`
  - `src/services/compact/compact.ts`
  - `src/services/compact/sessionMemoryCompact.ts`
  - `src/services/compact/grouping.ts`

The older source may not match the current build exactly, but it has been useful for revealing intended transformation rules.

## Confirmed rules

### 1. Consecutive user messages are merged for API send

Claude Code merges adjacent user messages into one API `role:"user"` message. This means multiple JSONL user entries can collapse into one live API message.

Implication for shelving:

- A compressed UUID range may be only a subset of one API user message.
- Dropping a whole matched API message is unsafe unless every fragment in it belongs to the shelved block.

### 2. Assistant chunks with the same `message.id` are merged

Streaming assistant output may be stored as multiple assistant messages sharing the same `message.id` but different UUIDs, for example:

- thinking
- text
- tool_use

These are later merged into one assistant API message.

Implication for shelving:

- Matching must work at fragment level, not just whole-message level.
- Compaction/slicing must preserve same-`message.id` siblings or thinking/tool blocks can be stranded.

### 3. User `tool_result` blocks are hoisted to the front of merged user content

When user messages merge, Claude Code hoists `tool_result` blocks before other sibling content blocks.

Observed result:

- Separate JSONL user messages can become one API message shaped like:
  - `tool_result`
  - `image`
  - `image`
  - `text`

Implication for shelving:

- Matching and rewrite logic must not assume original sibling order.

### 4. Media can appear in two valid wire shapes

Claude Code codepaths explicitly account for images/documents appearing:

- as top-level blocks in a user message
- nested inside `tool_result.content` arrays

Implication for shelving:

- Media matching must support both top-level and nested forms.
- A proxy fix that only handles one representation is incomplete.

### 5. Mixed messages are common

A single API user message can contain:

- a live `tool_result` for the immediately preceding tool call
- older shelved content fragments
- images/documents
- fresh user text

Implication for shelving:

- The correct rewrite is often “drop only some fragments,” not “keep all” or “drop all.”

### 6. Tool-pair integrity must survive merges

Because merged API messages can contain content from multiple stored messages, tool pairing can break in either direction:

- orphaned `tool_use`
- orphaned `tool_result`

Implication for shelving:

- Matching by content alone is not enough.
- Backstop matching by `tool_use.id` / `tool_result.tool_use_id` is necessary.

## Bugs we hit and what they taught us

### Orphaned tool use after compression

Observed failure:

- transformed request ended with assistant `tool_use`
- matching user `tool_result` had been dropped
- Anthropic returned `400` tool concurrency/pairing error

Lesson:

- Mixed user messages can contain both live tool-result content and shelved fragments.
- Whole-message dropping is unsafe.

### Shelved images surviving after the tool-pair fix

Observed failure:

- a merged API user message contained `tool_result + 18 image blocks`
- after the first fix, the `tool_result` fragment was dropped but the images survived

Root cause:

- the proxy matched `tool_result` fragments, but not `image` fragments
- before that fix, whole-message dropping had hidden this bug

Lesson:

- “Working before” may only mean a larger bug was masking a smaller one.

## Current proxy coverage

Current transform behavior in `src/proxy/transform.ts` now accounts for:

- assistant/user whole-message matching
- fragment-level matching for:
  - `text`
  - `tool_use`
  - `tool_result`
  - `image`
  - `document`
  - `search_result`
- tool-pair-ID backstop matching
- embedded-anchor substitution inside larger assistant/user messages
- drop-only fragment rewrites for mixed messages
- nested `tool_result.content` rewrites when smeared-in `document` / `search_result` fragments belong to shelved turns

Current regressions in `tests/transform.test.ts` cover:

- tool-result reminder drift
- tool-use metadata drift
- embedded tool-use anchors
- live `tool_result` preservation when only sibling text is shelved
- merged image fragment removal when those images belong to shelved turns
- merged document fragment removal when those documents belong to shelved turns
- nested `tool_result.content` removal for shelved `document` / `search_result` fragments

## Remaining risks / audit targets

These shapes are still worth auditing explicitly:

- any future media-like block types Claude Code may start moving around
- server-side tool blocks (`server_tool_use`, `server_tool_result`, `mcp_*`) if they ever become visible in request payloads the proxy sees
- cases where the same logical payload can appear both nested and top-level across different runs

## Practical guidance for future proxy work

- Treat JSONL as source material, not as a wire-format oracle.
- Assume the API payload may be a merged/reordered version of several JSONL entries.
- Prefer fragment-level matching whenever a message contains arrays of blocks.
- When fixing one mixed-message bug, re-check whether the old behavior had been masking another unmatched fragment type.
- If a size delta between original/transformed dumps changes drastically, inspect surviving media blocks before assuming substitution stopped working.

## Useful source references

- Current proxy transform: `src/proxy/transform.ts`
- Current proxy tests: `tests/transform.test.ts`
- Older CC normalizer: `~/claude-code/src/utils/messages.ts`
- Older CC compaction media stripping: `~/claude-code/src/services/compact/compact.ts`
- Older CC compaction pairing notes: `~/claude-code/src/services/compact/sessionMemoryCompact.ts`
