# Token efficiency (opencode)

Port of the [claude-token-optimization](https://github.com/jronminh/claude-token-optimization)
Claude Code hooks to opencode, as a single vanilla TypeScript plugin. Same design
philosophy: **warn, never block** — nothing throws, no tool is stopped, and the
agent feels vanilla most of the time because warnings only surface when a point
is actually worth making (backoff on repeats).

This repo now also ships the **budget** plugin (see below), so both opencode
efficiency plugins live here as the source of truth.

## What it does

- **Repeated reads** — logs every `read` per session; re-reading the same file
  warns the model on the 2nd/4th/8th… read (exponential backoff).
- **Oversized `.md` reads** — warns at ~12,500 / 25,000 est. tokens (soft/hard,
  chars/3.5) to prefer `grep -n` over full reads, with the same power-of-two
  backoff.
- **Instructions-file cap** — a tight ~1,000-token cap on the file that is
  injected into every turn, counting only *user-editable* content (the managed
  `opencode-code-termux-native` block is excluded, exactly like the Claude-side
  hook excludes the termux block from `~/.claude/CLAUDE.md`).
- **Context monitor** — reads the session's REAL token usage from the latest
  `step-finish` part (`bun:sqlite` on `opencode.db`, SDK fallback) every 15
  tool calls, and warns when a checkpoint (100k…2M) is crossed, naming the
  heaviest tools so far.
- **Large-call flag** — flags a tool call abnormal for its own tool type
  (>8x that tool's running session average); the `find-large-turns.sh` analog.
- **Bash-output warning** — Bash is the biggest token source; a large `bash`
  result gets a hard nudge to pipe through `head`/`grep`/`tail`.
- **Every-turn rules** — a terse one-line rules reminder is injected into
  `output.system` each turn via `experimental.chat.system.transform` (so the
  habits survive compaction); the full block is injected once per session and
  again after a compaction.
- **Standardized markers + relay** — every injected block starts with
  `# <name>-inject: <kind>`; `environment-snippet.md` (installed into
  `environment.md`) tells the model to relay them to the user. TUI toasts are
  implemented but off by default.

## How warnings reach the model

Claude Code's `PreToolUse` hooks get an `additionalContext` field to inject
content into the model's context. OpenCode's `tool.execute.before` output is
just `{ args }` — there is **no** metadata/additional-context field — so the
natural port of that mechanism silently does nothing (the original port shipped
that dead path: it wrote `output.metadata.tokenOptimizationWarn`, which never
exists at runtime). This port instead **queues warnings in-process and flushes
them into the next system prompt** via `experimental.chat.system.transform`:

- the model sees the warning on the very next turn (right after the offending
  tool result),
- the user sees nothing extra (no injected lines in tool output) — vanilla feel,
- the queue is cleared after flushing, so nothing accumulates or duplicates.

`client.app.log` records every warning for audit regardless.

## Budget plugin

- **`budget.ts`** — the merged balance-watch + budget-optimizer plugin. Polls
  the provider balance and today's spend, prices each step from `opencode.db`'s
  real per-step `cost`/`tokens`, warns on oversized reads / unbounded bash /
  expensive steps, and injects one detailed `# budget-inject: budget` block on
  a fixed step cadence (default every 15 chat steps). It also fires the
  `# budget-inject: session-limit` per-chat spend guard. Exposes `budget_status`
  (balance + today's spend) and `budget_report` (day's cost, token-class split,
  peak/off-peak, burn rate, top sessions, and this session's own breakdown).

Reads `~/.local/share/opencode/opencode.db` read-only and never blocks.

## Install

```bash
bash install.sh
```

Copies every `plugin/*.ts` to `~/.config/opencode/plugins/`, ensures
`@opencode-ai/plugin` is declared in `~/.config/opencode/package.json`, and
appends `environment-snippet.md` (the relay instruction) to
`~/.config/opencode/environment.md` between markers (replacing any previous
copy). Plugins load at the next opencode session start. Re-running is
idempotent.

## Uninstall

Remove the matching files under `~/.config/opencode/plugins/` (and optionally
drop the `@opencode-ai/plugin` entry from `~/.config/opencode/package.json`).

## What's still not ported

- **Window / percentage guessing** — deliberately not done: the real context
  window can't be derived from the transcript, so the monitor reports the exact
  token count and the checkpoint only, never a percentage.
- **`calibrate-baseline.sh`'s cross-session baseline** — the large-call flag
  uses a running per-session average instead, so no external calibration file
  is needed.

## License

GPL-3.0, matching claude-token-optimization.