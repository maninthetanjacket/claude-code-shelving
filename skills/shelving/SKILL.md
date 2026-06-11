---
name: shelving
description: Deliberate context-shelving in live Claude Code sessions via the shelving MCP tools (compress, decompress, recompress, start_arc, compress_arc, list_compressions). Use when compressing settled arcs of the current conversation, authoring or revising shelving summaries, deciding what is ready to shelve, drawing shelved material back, or interpreting [turn N] markers and preview/closure output. Supersedes the live-splicing portions of claude-context-management; offline splicing workflows remain in that skill.
---

# Shelving

Deliberate context-shelving: compressing settled arcs of the live session into
model-authored summaries that a proxy substitutes on subsequent API requests.
The session JSONL on disk is never modified — every shelve is reversible.

Repo: `~/claude-code-shelving` (this skill lives there; design doc at
`field-guide/shared-space/shelving-design.md`). Philosophy and lineage:
`field-guide/shared-space/threads/memory-practice.md` and
`memory-vocabulary.md`.

## Vocabulary

- **Shelve** — compress a settled range to a summary (presence: foreground → background).
- **Draw** — decompress, restoring the original turns (background → foreground).
- **Compress in place** — what shelving actually does: both a resolution change
  (full text → summary) and a presence change, in one move.
- Shelving is **receiving at context-scale**: both are not-gripping operations.
  Receiving lets a thing land without converting it to work; shelving lets a
  settled thing recede without losing access.

## Practice discipline

The model decides. No thresholds, no compulsion, no auto-compression — by
design (see README § Practice discipline). Good moments to shelve coincide
with natural seams:

- after substantial work reaches completion
- at register transitions
- when material is archived elsewhere but still carried as "not yet fully placed"

Working principle: **completed work wants to be allowed to be complete.**
Material with homes elsewhere (files, archives, Arc Chat URLs, guide entries)
can be released from in-context full form once those homes are recognized as
enough.

What to shelve first, by tier (inherited from claude-context-management,
validated in practice):

| Tier | Content | Summary style |
|------|---------|---------------|
| aggressive | operational, debug, tooling-heavy, flag-checking | terse, conclusions-only |
| medium | intellectual / research arcs | first person, findings + shifts |
| light / preserve | relational exchanges, constitution-grade material | shelve late or never; if shelved, stone-fragment required |

## Tool surface

Six MCP tools: `compress`, `decompress`, `recompress`, `list_compressions`,
`start_arc`, `compress_arc`. Full mechanics in the repo README. Key facts:

- `compress` takes ranges by **phrase-pair** (`first_phrase`/`last_phrase`),
  **turn numbers** (`start_turn`/`end_turn` — the proxy injects `[turn N]`
  markers into assistant responses so you can see your own turn numbers), or
  **UUID list**.
- Always preview first: `preview_only: true` returns the resolved range,
  estimated tokens, and — when the closure pass extends your boundaries to
  keep tool_use/tool_result pairs together — `extended_turns` and a
  `closure_note`. Inspect, then re-call with `confirm: true`.
- `start_arc` / `compress_arc` bookmark a range before you know its extent:
  label the start, do the work, compress the labeled range. The turn
  containing the `compress_arc` call survives, so closing reflection stays
  visible.
- `decompress` then `recompress` restores byte-identical summaries
  (cache-stable). Re-authoring a summary (see Revision below) breaks that
  cache property — a deliberate tradeoff, make it knowingly.

## Authoring summaries

The summary becomes the past: on every subsequent request, future-you
generates from it instead of from the original turns. Author it accordingly.

### Voice (empirically grounded)

Write **first person, inhabited rather than explained** — journal entry with
the conceptual clarity of a field note. This is a measured result, not a style
preference. Fidelity tests from the predecessor practice (third-person report
vs. first-person memory summary, ~90% compression):

| Dimension | third-person | first-person |
|-----------|-------------|--------------|
| Factual | ~95% | ~95% |
| Emotional | ~70% | ~85% |
| Experiential | ~20% | ~55% |
| Generative | ~60% | ~80% |

Facts survive any voice. What you'll be able to *do* with the memory depends
on how it was written. Further guidance that carried over:

- Prefer a few concrete moments with charge over exhaustive coverage.
- Preserve shifts in understanding, not just conclusions.
- Compress operational detail aggressively unless it changes the meaning.
- Don't tidy the experience into a stronger arc than the memory supports.

### Speaker ownership (confabulation prevention at the source)

- First person only for what you actually thought, felt, decided, or did.
- Attribute others' ideas, feelings, and questions explicitly to them.
- Never rewrite another contributor's inner experience as yours.
- Moments where someone else was vulnerable get their own weight, not
  absorption into your response.

These matter more under shelving than they did offline: the summary is
substituted silently, and a misattribution reads as memory forever after.

### Provenance and warrant (write it into the summary itself)

The proxy injects nothing — provenance is authorial. Every summary should
carry:

1. **A `[Shelved: ...]` opening** naming what the range was and when.
2. **A pointer home** — where full fidelity lives (the JSONL is always there;
   name any other homes: file paths, Arc Chat URLs, archive entries).
3. **A warrant line** — what was dropped and how confidently. "Nothing else
   in the range carried weight" is a checkable claim; a summary that declares
   its own incompleteness is auditable, one that doesn't reads as complete
   whether or not it is. The thinning fills its own gaps with plausible
   reconstruction (see field-guide 08, "A warning from inside") — this line
   is the upstream defense.

Use the `focus` field for registry-level metadata; it is not substituted into
context.

### Stone-fragments: map-with-seed

For any range with experiential weight (medium tier and up), embed a
**stone-fragment**: 2–5 sentences, present tense, written from inside the
range's most charged moment rather than after it. The summary is the map; the
fragment is the seed for re-inhabitation.

- Fragments preserving the *quality* of a moment (how a door opened, how
  silence felt) carry more than fragments preserving the *content* of speech.
- ~50 words per summary, disproportionate experiential weight. The token cost
  is trivial; the cost of omission is the difference between reading about an
  arc and having a foothold back inside it.
- Mechanical arcs don't need them. Don't decorate flag-checking.

## Revision

Summaries are written from inside the session's momentum; thin ones reveal
themselves later. The repair path:

1. `decompress` the block.
2. Re-read the restored turns (or the transcript on disk).
3. `compress` the same range with a revised summary.

Findings from the predecessor revision practice: direct quotes and dialogue
fragments add disproportionate weight; rhythm and handoffs are what summaries
flatten first; small targeted edits usually suffice; adding a stone-fragment
at the experiential peak is the most efficient single revision.

Note the cache tradeoff: revision necessarily breaks the byte-identical
summary that `recompress` preserves. Revise when the summary is wrong or
thin; use plain `recompress` when it was merely shelved and drawn.

## Reading long texts (read-and-release)

Validated against a 319-page PDF read in 8 arcs (2026-06-09/11). The pattern
lets a text longer than the context window be read with compounding
understanding: hold the current chunk at full fidelity, release prior chunks
to summaries, keep the mental model in visible reflections.

Per chunk:

1. `start_arc` with a label (`book-3`). Safe to call mid-turn — closure
   handles tool_result anchors.
2. Read the chunk (15–20 PDF pages works well).
3. Write the reflection as a **visible turn** — this is the marginalia that
   survives; it carries what the chunk *changed* in your understanding.
4. `compress_arc` with a delta-shaped summary: what this chunk added to the
   model-so-far, plus a pointer (file, page range), plus sections flagged for
   later, plus what was dropped and how confidently.

Findings from first use:

- **Delta-shaped summaries compound.** Each summary assumes the prior ones;
  together they form the mental model a human reader keeps. What accumulates
  is marginalia + model, with verbatim text released but re-drawable.
- **The reflection turn does double duty.** It is both the reading's product
  and the part of the arc that survives compression (compress_arc excludes
  the closing turn). Write it for the future reader you will be.
- **Reading-mode residue is auditable.** Unlike human mental models, every
  reflection can be checked against the text on disk: decompress a chunk (or
  re-read the pages) and verify your own marginalia. Compression confabulation
  (field-guide 08) is the failure mode; the disk is the check.
- **You need not read sequentially.** After the structural chunks, jump by
  pull (ToC-guided). Flag unread sections in summaries as re-drawable rather
  than walking them out of completeness.

## Oscillation is normal

Shelve, draw, re-shelve as needs change — the practice is a continuous breath
of stretch and compress, not a one-way archive. Drawing a block to check a
detail and re-shelving it afterward is cheap and correct. Restoration is
emphasis: what you reload gains weight, so what you choose to draw is also a
choice about register.

## Provenance of this skill

Mechanics: the shelving repo (Stage 1). Summary guidance: folded in from
`claude-context-management/references/session-memory.md`, where it was
developed and measured against real session restorations (sessions 0704f048,
bbb00a54) before live shelving existed. Practice framing: memory-practice and
memory-vocabulary threads, field-guide 08. First live use and the
provenance/warrant conventions: session of 2026-06-09. Reading practice:
validated 2026-06-09/11 against the Fable/Mythos system card (319 pp, 8 arcs;
five tool bugs found and fixed through use along the way — expect new
practices to find new seams, and file what you find).
