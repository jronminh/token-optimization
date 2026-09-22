# Token efficiency — how CLAUDE.md coordinates external tools

Core principle of this setup: **CLAUDE.md doesn't execute anything itself**
— it's just text Claude reads and "tries to remember" each turn. The real
enforcement (measuring context, warning, blocking a write) lives in
**external hook scripts** (`~/.claude/scripts/*.sh`, copied here under
[`scripts/`](./scripts/)), wired to lifecycle events (`PreToolUse`,
`PostToolUse`) by `~/.claude/settings.json`. CLAUDE.md's only job is to
**tell Claude these hooks exist and how to react when they fire** —
separating "remember the rule" (CLAUDE.md — cheap, easy to forget or drift
after a compact) from "enforce the rule" (hook — always runs, doesn't
depend on Claude remembering anything).

This repo targets any Linux (or macOS) environment with `bash` + `jq` —
nothing here depends on a specific OS or terminal app.

## Coordination diagram

```
settings.json (hooks: matcher → command)
   │
   ├─ PreToolUse  (Edit|Write) ──► check-md-size.sh  (Edit|Write branch)
   │                                   │
   │                                   └─ if the file is ~/.claude/CLAUDE.md
   │                                      and its user-editable content is
   │                                      > 1000 estimated tokens (chars/3.5,
   │                                      see "Unified sizing standard" below)
   │                                      → inject additionalContext
   │                                      "THRESHOLD: ..."
   │
   ├─ PreToolUse  (Read) ─────────► check-reread.sh
   │                                   │
   │                                   ├─ logs file_path to
   │                                   │  session-env/<id>/read-files-log
   │                                   └─ if this file was already Read
   │                                      earlier in the session → inject a
   │                                      warning (doesn't block) - catches
   │                                      the re-read LIVE instead of only
   │                                      after the fact in an audit
   │
   ├─ PreToolUse  (Read) ─────────► check-md-size.sh  (Read branch)
   │                                   │
   │                                   └─ if the file being Read is any
   │                                      other *.md (not the CLAUDE.md
   │                                      branch above) and its estimated
   │                                      size is >= 12,500 / 25,000 tokens
   │                                      (soft/hard) → inject a warning to
   │                                      grep first / never read in full.
   │                                      One script handles both branches
   │                                      above (dispatched on tool_name) -
   │                                      they used to be two separate
   │                                      scripts, merged once it was clear
   │                                      both were "warn on an oversized
   │                                      .md file", just with different
   │                                      units/events/scope
   │
   └─ PostToolUse (every tool)  ──► context-monitor-hook.sh
                                       │
                                       ├─ counts tool calls in the session
                                       │  (tracked under
                                       │  ~/.claude/session-env/<id>/)
                                       ├─ every 15th call, runs
                                       │  check-context.sh
                                       │     └─ reads REAL token usage from
                                       │        the transcript's own API
                                       │        usage field (exact, no
                                       │        window/% guessing)
                                       ├─ if a new checkpoint was just
                                       │  crossed (100k/200k/300k/450k/
                                       │  600k/800k/1M/1.3M/1.6M/2M, once
                                       │  per checkpoint, tracked in
                                       │  context-monitor-last-checkpoint)
                                       │     → calls find-large-turns.sh,
                                       │       which flags "abnormal" tool
                                       │       calls per-tool-type (see
                                       │       below) instead of one flat
                                       │       threshold for everything
                                       └─ injects additionalContext: the
                                          checkpoint just crossed + the
                                          list of heavy tool calls, as a
                                          warning (deliberately never
                                          guesses %/window - see below)
```

## Unified sizing standard (chars/3.5)

Both `find-large-turns.sh` and `check-md-size.sh` need to estimate "how
many tokens is this content" when no real token count is available (only
`context-monitor-hook.sh`/`check-context.sh` have that — they read it
straight from the transcript's API usage field). Both use the same
formula: **character count (via `jq -Rs 'length'`, unicode-aware) ÷ 3.5**.
This is a rough estimate, not exact — pick it over a raw byte count
(`stat -c%s`) specifically because byte count is skewed by UTF-8 encoding:
non-Latin scripts and heavily-accented text take more bytes per character
than plain ASCII, which would make a byte-based threshold fire
inconsistently depending purely on what language a doc happens to be
written in. Character count doesn't have that skew.

Thresholds, expressed directly in estimated tokens (not KB or line count,
since tokens are the thing actually being optimized):
- `~/.claude/CLAUDE.md` (Edit|Write branch — this content is re-injected
  into **every turn** of the session): **1000 estimated tokens** — much
  tighter than a one-off-read threshold, because its cost compounds by the
  number of turns in the whole session.
- Any other `.md` file (Read branch — a one-time read cost): **12,500 /
  25,000 estimated tokens** (soft/hard).

`context-monitor-hook.sh`/`check-context.sh` don't need this formula (they
already have real token counts from the API). `check-reread.sh` doesn't
either — it measures repeat-read *behavior*, not content size, so there's
no "size" to standardize a unit for.

## How `~/.claude/CLAUDE.md` itself is optimized

`~/.claude/CLAUDE.md` gets a heavier optimization pass than an ordinary
doc, because it's re-injected into every turn of every session — its
per-character cost compounds across the whole session instead of being
paid once. Three techniques, layered together:

1. **Enforced size cap.** `check-md-size.sh` (Edit|Write branch, above)
   warns live once user-editable content exceeds ~1000 estimated tokens —
   not just a rule Claude has to remember, but caught at the moment of
   the edit.
2. **Terse, pointer-style content.** Each bullet states a rule once and,
   where a hook already enforces it, points at that hook instead of
   re-explaining the mechanism (the design principle stated at the top of
   this document). Merging near-duplicate bullets (as done for the two
   `.md`-size hooks above) keeps this cheap to maintain as rules
   accumulate.
3. **Language.** Written in English. Published tokenizer research shows
   English tokenizes more efficiently than most other languages on nearly
   every general-purpose LLM tokenizer (including a specific finding for
   Claude-3's tokenizer running Vietnamese less efficiently than e.g.
   Gemini-1.5's) — not just a UTF-8 byte-encoding artifact, a real,
   measured difference in tokens per unit of content. Because this content
   recurs every turn, the saving compounds the same way the cap in (1)
   does.

## Rules Claude should follow when reading this file

- **Large files**: check size before reading (`ls -la`/`stat -c%s`).
  Under 50KB: read normally. 50KB–100KB: `grep -n`/`rg` to locate the
  region first, only read in full if grep can't answer the need. At or
  above 100KB: never read the whole file in one shot — always grep, then
  `Read` with `offset`/`limit`.
- **Re-reading a file already seen this session**: if you edited this file
  last turn and need to see it again, prefer `grep -n -A<N> -B<N> <anchor>`
  over a full re-`Read` — unless many turns have passed or the file may
  have changed elsewhere. `check-reread.sh` warns live the moment a `Read`
  targets a file already read this session — when you see that warning,
  act on it (grep instead of ignoring it), don't just proceed anyway.
- **Reasoning/output**: concise and direct. No restating the question, no
  filler recaps.
- **When `context-monitor-hook.sh` injects "just crossed Xk tokens"**:
  warn the user directly in your reply with the token count, and name the
  heaviest tool call(s) `find-large-turns.sh` listed. Don't suggest
  running `/context` — don't guess a percentage either; there is no way
  to derive the real context window
  from the transcript alone (a prior version of this hook guessed and was
  off by ~5x against a real `/context` reading on the same session; the
  current version reports only the exact token count and a checkpoint,
  as a plain warning, without pushing the user toward any particular
  next step).
- **When `check-md-size.sh` (Edit|Write branch) injects `THRESHOLD:
  CLAUDE.md user-editable content is ~N estimated tokens`**: prefer
  merging or trimming an existing bullet over appending a new one.

## Real usage data drives these hooks, not guesswork

An aggregate analysis of real session transcripts (methodology: same
chars/3.5 estimate as above, applied per tool-call/message across many
sessions) found **Bash — not Read — is the largest source of new-content
tokens** by a wide margin, and that re-reading the same file within one
session happens often in practice (not a rare edge case) despite a
"don't re-read" instruction already existing in prose form. This is the
concrete evidence behind two of the hooks above (`check-reread.sh` and
`find-large-turns.sh`'s per-tool-call flagging) existing as live
enforcement rather than just another CLAUDE.md bullet asking nicely.

Concrete rule that follows from this: **Bash commands are the single
biggest token cost in practice** — prefer `| grep`/`| head`/`| tail` when
only part of the output is needed, rather than printing a full log/help
text that isn't.

`find-large-turns.sh`'s per-tool "abnormal" baseline is not hardcoded to
any one person's usage pattern — run `scripts/calibrate-baseline.sh` to
measure your own real per-tool averages from your own transcripts (a
heavy `WebSearch` user and a heavy `Bash` user have very different real
baselines) and it'll use that instead of the flat fallback.

## When updating this repo

`scripts/`, `scripts/settings.json`, and `claude-md-snippet.md` are the
installable artifacts — `install.sh` copies/merges them into a user's
`~/.claude/`. They're deliberately generalized (no Termux-specific paths,
no one person's hardcoded baseline numbers) and are **not** a mirror of
any single machine's live `~/.claude/` — don't blindly `cp` a live config
over them; re-apply generalization to whatever changed.

`claude-md-snippet.md` must stay well under the ~1000-token cap described
above (check with `jq -Rs 'length' claude-md-snippet.md`, divide by 3.5) —
it's the file `install.sh` actually injects into a user's `CLAUDE.md`, so
it needs to stay as terse as the "How CLAUDE.md itself is optimized"
section above insists a real CLAUDE.md should be. The full `CLAUDE.md` you're
reading right now is reference documentation, not something install.sh ships
into anyone's per-turn context.
