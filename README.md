# Token efficiency (opencode)

Port of the [claude-token-optimization](https://github.com/jronminh/claude-token-optimization)
Claude Code hooks to opencode, as a single vanilla TypeScript plugin. Same design
philosophy: **warn, never block** — nothing throws, no tool is stopped, and the
agent feels vanilla most of the time because warnings only surface when a point
is actually worth making (backoff on repeats).

This repo now also ships the two **budget** plugins (see below), so all three
opencode efficiency plugins live here as the source of truth.

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
- **Every-turn rules** — a terse rules block is injected into `output.system`
  each turn via `experimental.chat.system.transform`, so the habits survive
  compaction (the analog of appending `claude-md-snippet.md` to `CLAUDE.md`).

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

## Budget plugins

- **`budget-watch.ts`** — polls the provider balance and injects a
  `# budget-watch-inject: budget` block when the balance or daily spend crosses
  a threshold; exposes the `budget_status` tool.
- **`budget-optimizer.ts`** — tracks *where* spend goes from opencode.db's real
  per-step `cost`/`tokens`, warns before expensive reads/steps, and injects a
  budget-mode block. Exposes the `budget_report` tool, which reports the day's
  cost, token-class split, peak/off-peak, burn rate, top sessions, and **this
  session's own cost + token breakdown**.

Both read `~/.local/share/opencode/opencode.db` read-only and never block.

## Install

```bash
bash install.sh
```

Copies every `plugin/*.ts` to `~/.config/opencode/plugins/` and ensures
`@opencode-ai/plugin` is declared in `~/.config/opencode/package.json`.
Plugins load at the next opencode session start. Re-running is idempotent.

## Uninstall

Remove the matching files under `~/.config/opencode/plugins/` (and optionally
drop the `@opencode-ai/plugin` entry from `~/.config/opencode/package.json`).

## What's deliberately dropped

- **Context monitoring** (`context-monitor` / `check-context.sh` upstream):
  that reads REAL per-message API token usage from the transcript. The opencode
  SDK `Message` type has no per-message `usage` field, so there's no faithful
  source — skipped rather than faked, same call the original repo made about
  guessing the context window.
- **`find-large-turns.sh` / baseline calibration**: no token-usage source to
  drive "abnormal call" detection, for the same reason.

## License

GPL-3.0, matching claude-token-optimization.