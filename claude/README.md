# claude-token-optimization

Five [Claude Code](https://claude.com/claude-code) hooks that automatically
catch token-wasting patterns live, instead of relying on a CLAUDE.md rule
Claude has to remember every turn. Built and tuned against real session
data, not guesswork — see "Why hooks, not just CLAUDE.md rules" below for
the reasoning and the incident that drove the design.

**Requirements:** Linux or macOS, `bash`, `jq`. No dependency on any
specific terminal app or OS distribution.

## What's here

| File | Event | What it does |
|---|---|---|
| `check-reread.sh` | `PreToolUse` (`Read`) | Warns if a file was already `Read` earlier in the session |
| `check-md-size.sh` | `PreToolUse` (`Edit\|Write` and `Read`) | Warns if a `.md` file (or `CLAUDE.md` specifically) is large enough that reading/growing it wastes tokens |
| `context-monitor-hook.sh` | `PostToolUse` (every tool) | Periodically checks real token usage and reports checkpoints |
| `check-context.sh` | called by the above | Reads the session's real token usage straight from the transcript's API usage field |
| `find-large-turns.sh` | called by the above | Flags individual tool calls that are abnormally large for their own tool type |
| `calibrate-baseline.sh` | run manually | Measures your own per-tool token averages from your real transcripts, for `find-large-turns.sh` to use |

`scripts/settings.json` is a **hooks-only snippet** — merge its `hooks`
block into your own `~/.claude/settings.json` rather than overwriting the
whole file (your settings.json likely has other keys — `env`,
`permissions`, `theme`, other hooks — this snippet only shows the parts
relevant to token efficiency).

## Install

```
bash install.sh
```

`install.sh` reads and writes files under `~/.claude/` — read it before
running it if you'd rather not run an unfamiliar script against your own
config unreviewed. What it does, each step safe to re-run:

1. Copies `scripts/*.sh` into `~/.claude/scripts/` and makes them executable.
2. Backs up your existing `~/.claude/settings.json` (as
   `settings.json.bak.<timestamp>`), then merges `scripts/settings.json`'s
   `hooks` into it — existing hooks for the same or different events are
   kept, not replaced; running the installer again doesn't duplicate
   entries.
3. Appends [`claude-md-snippet.md`](./claude-md-snippet.md) (the terse
   rules Claude needs to react correctly to these hooks — not the full
   `CLAUDE.md` in this repo, which is reference documentation and far
   longer than you'd want re-injected into every turn) into
   `~/.claude/CLAUDE.md`, wrapped in a marker comment so re-running the
   installer skips it instead of duplicating it.

Optional next step, once you have a few real sessions under
`~/.claude/projects`: `bash ~/.claude/scripts/calibrate-baseline.sh` — see
"calibrate-baseline.sh" below.

**To install by hand instead:** copy `scripts/*.sh` to `~/.claude/scripts/`
and `chmod +x` them, merge `scripts/settings.json`'s `hooks` block into
your own `~/.claude/settings.json` yourself, and append
`claude-md-snippet.md`'s content to your `~/.claude/CLAUDE.md`.

**To uninstall:** remove the block between the
`<!-- claude-token-optimization:begin/end -->` markers in
`~/.claude/CLAUDE.md`, remove the matching hook entries from
`~/.claude/settings.json` (or restore a `settings.json.bak.*` backup), and
delete the `*.sh` files this installed under `~/.claude/scripts/`.

None of this requires restarting Claude Code — hooks are read fresh from
`settings.json` on the next matching tool call.

## Why hooks, not just CLAUDE.md rules

CLAUDE.md text is something Claude reads and *tries* to remember — it can
drift or get missed after a long session, a compact, or just because the
model didn't happen to apply it that turn. A hook, by contrast, always
fires on its matching event regardless of what the model remembers. The
concrete case for this: a "don't re-read files" rule already existed in
prose, and a transcript analysis of real sessions still found the same
file being re-read multiple times within one session — a rule stated but
not consistently followed. `check-reread.sh` catches that behavior live,
the moment it happens, instead of only being visible after the fact in an
audit. That gap is why these five exist as scripts instead of five more
CLAUDE.md bullets.

## The hooks in detail

### check-reread.sh

Logs every file path `Read` to a per-session log
(`~/.claude/session-env/<session_id>/read-files-log`). If a `Read` targets
a path already in that log, it injects a warning (doesn't block the read)
suggesting `grep -n -A/-B <anchor>` instead of a full re-read, unless the
file may genuinely have changed or many turns have passed.

### check-md-size.sh

One script, two branches (dispatched on `tool_name` from the hook input):

- **`Edit|Write` on `~/.claude/CLAUDE.md` specifically**: counts the
  user-editable content (excluding anything between the
  `MANAGED_BLOCK_START`/`MANAGED_BLOCK_END` markers set at the top of the
  script, if your CLAUDE.md has a tool-managed section like that — leave
  both empty if it doesn't) and warns past **1000 estimated tokens**. Tighter than
  the generic threshold below because this file is re-injected into every
  turn of the session — its cost compounds by turn count, not paid once.
- **`Read` on any other `.md` file**: warns at **12,500 / 25,000 estimated
  tokens** (soft/hard) — a one-time read cost, so a much looser bar.

**Why "estimated tokens" and not KB or line count:** both branches need a
token estimate when no real count is available (only the
context-monitor/check-context pair below has a real one, from the API).
The formula used everywhere in this repo is **character count (via
`jq -Rs 'length'`, which counts Unicode codepoints, not bytes) ÷ 3.5**.
A raw byte count (`stat -c%s`) was tried first and dropped: UTF-8 encodes
non-Latin scripts and heavily-accented text in more bytes per character
than plain ASCII, so a byte-based threshold fires inconsistently purely
based on what language a document happens to be written in. Character
count doesn't have that skew. 3.5 chars/token is a rough estimate
calibrated against real transcript data, not an exact conversion — if you
have your own measured ratio for your typical content, adjust the `2/7`
math in the scripts (`2/7 == 1/3.5`).

### context-monitor-hook.sh + check-context.sh

Every 15th tool call in a session, `context-monitor-hook.sh` calls
`check-context.sh`, which reads the session's transcript and extracts the
**real** token usage (`input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`) from the most recent assistant message's
`usage` field — the same number the API actually billed, not an estimate.
If usage just crossed a new checkpoint (100k/200k/300k/450k/600k/800k/1M/
1.3M/1.6M/2M — linear early, coarser later so a long session isn't spammed
every 100k), it calls `find-large-turns.sh` and injects the checkpoint,
the real token count, and the heaviest recent tool calls as context for
Claude to relay to the user.

**Deliberately does not report a percentage or a context window size.**
An earlier version guessed the window (assume 200k, or 1M once usage
already exceeded 200k) and computed a percentage from that guess. On a
real session this was checked against the interactive `/context` command:
the guess-based version reported **82%**, the real `/context` reported
**16%** — the session was actually in an extended 1M window, but usage
hadn't yet crossed 200k, so the heuristic picked the wrong window and was
off by roughly 5x. There is no field in the transcript that records the
real window size, so this can't be fixed by guessing better — only by not
guessing. The current version reports the exact token count and which
checkpoint was just crossed, as a plain warning, without suggesting the
user run `/context` or any other next step.

### find-large-turns.sh

Flags individual messages/tool calls in the current transcript that are
abnormal **for their own tool type** — a `Read` call and a `Bash` call
don't have the same normal size, so one flat threshold for both either
misses real problems in cheap tools or spams warnings on tools that are
normally larger. "Abnormal" means more than `MULTIPLIER` (default 8x) that
tool's own average call size. A numeric argument still works as a flat
threshold across every tool type, for backward compatibility.

### calibrate-baseline.sh

`find-large-turns.sh` needs a per-tool average to compare against. Rather
than shipping one person's hardcoded numbers as if they applied
universally — they don't; a workload that's mostly `WebSearch` has a very
different real average than one that's mostly `Bash` — this script
measures **your own** real usage: it scans every transcript under
`~/.claude/projects`, computes the average estimated-token size per tool
type (same chars/3.5 formula as above), and writes the result to
`~/.claude/session-env/baseline-tokens.json`. `find-large-turns.sh` reads
that file if present; if it doesn't exist yet, every tool type falls back
to one flat `DEFAULT_AVG` (400 tokens) until you calibrate. Re-run it any
time your usage pattern changes meaningfully.

```
bash scripts/calibrate-baseline.sh
```

## Design principle: warn, don't block

None of these hooks use `permissionDecision: "deny"` or otherwise stop a
tool call. They all inject `additionalContext` (a non-blocking signal
Claude reads and is instructed, via CLAUDE.md, to relay to the user) and
let the turn proceed. This is a deliberate choice, not an oversight: these
are frequent, low-stakes signals (a re-read, a large file, a token
checkpoint) — the cost of a false positive interrupting the user's flow
outweighs the cost of an occasional missed signal. Reserve a blocking
`permissionDecision`/`decision` for something rare and genuinely
consequential (e.g. a destructive action needing confirmation), not for
advisory nudges like these — a hook that blocks on every re-read or every
large file would make the tool actively annoying to use, which defeats
the purpose of automating a nudge in the first place.

A related finding worth knowing if you're building similar hooks: the
top-level `systemMessage` field's behavior is easy to misread. For
`PreToolUse`/`PostToolUse`, `systemMessage` is documented as a message
shown **to Claude** (in the transcript / as a system reminder to the
model), not to the human user directly — it will not appear anywhere
visible in the terminal UI at these events, the same as
`hookSpecificOutput.additionalContext`. If you need something to actually
reach the human, route it through `additionalContext` and have your
CLAUDE.md instructions tell Claude to relay it in its reply — don't rely
on `systemMessage` alone to surface information to the user at these
events; whether it renders to a human at all depends on the specific
hook event (some, like `Stop` or `Notification`, have different documented
behavior — check the current docs for the event you're using before
assuming either way).

## A note on language for your own CLAUDE.md

If your `~/.claude/CLAUDE.md` is written in a language other than English,
know that published tokenizer research (across GPT/Claude/Llama-family
tokenizers) consistently finds English tokenizes more efficiently than
most other languages on general-purpose tokenizers — not because English
is inherently denser in information, but because tokenizer vocabularies
are trained on English-dominated corpora, so English text merges into
fewer, longer tokens while under-represented languages fragment into more
tokens for the same content. One study found Claude-3's tokenizer
specifically runs Vietnamese less efficiently than e.g. Gemini-1.5's for
equivalent content. Since `CLAUDE.md` content is re-injected into every
turn, this is one of the few token-efficiency levers where a fixed
percentage saving actually compounds over a whole session rather than
being paid once — worth considering if you're optimizing hard for token
cost, independent of any of the hooks above.

## Tuning

Every threshold (token counts, the checkpoint list, `MULTIPLIER`,
`DEFAULT_AVG`, the chars-per-token ratio) is a plain constant near the top
of its script — no config file, no environment variables to look up. Open
the script and change the number.

## Updating this repo

`scripts/`, `scripts/settings.json`, and `claude-md-snippet.md` are the
installable artifacts — `install.sh` copies/merges them into a user's
`~/.claude/`. Editing them here doesn't change any already-installed
Claude Code setup; re-run `install.sh` after a change to pick it up.
`claude-md-snippet.md` in particular must stay well under ~1000 estimated
tokens (`jq -Rs 'length' claude-md-snippet.md`, divide by 3.5) — it's what
actually gets injected into a user's `CLAUDE.md` every turn.

## License

[GPL-3.0](./LICENSE)
