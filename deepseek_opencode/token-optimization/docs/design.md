# Design notes

## Why the warning channel differs from the Claude-side repo

Claude Code's `PreToolUse` hooks return a `hookSpecificOutput.additionalContext`
field that is injected straight into the model's context. OpenCode's
`tool.execute.before` plugin hook exposes only `output.args` — there is no
meta-data or additional-context field on the installed
`@opencode-ai/plugin@1.18.x` (`tool.execute.before` output type is
`{ args: any }`, verified in `dist/index.d.ts`).

The first port of this repo shipped the pattern anyway
(`output.metadata.tokenOptimizationWarn = ctx`): it silently does **nothing** at
runtime (the field never exists), so every "warn" only ever reached
`client.app.log`. That's the bug this port fixes.

Delivery mechanism chosen here: an in-process queue that is flushed into
`output.system` via `experimental.chat.system.transform` on the next model call.

- the model sees the warning on the very next turn, right after the offending
  tool result;
- the user sees nothing (no lines injected into tool output) — vanilla feel;
- the queue is cleared on flush, so warnings can't accumulate or duplicate;
- fails quiet: if the session ends with pending warnings, they're simply never
  emitted (no cost, no error).

## Why the instructions-file cap can go silent

The Claude-side hook caps `~/.claude/CLAUDE.md` at ~1000 est. tokens, excluding
the installer-managed `claude-code-termux-native` block. This port targets
`~/.config/opencode/environment.md` and **excludes the same kind of managed
block** (`<!-- opencode-code-termux-native:begin -->` … `:end -->`). On this
device `environment.md` is entirely managed content — user-editable content is
~0 tokens, so the cap correctly stays silent until a real user-authored
instructions file exists. If you add user content above the managed block, the
cap starts enforcing automatically.

## apply_patch

`apply_patch` carries file paths in `patchText` marker lines
(`*** Add|Update|Delete|Move to File: <path>`), not a `filePath` arg — opencode
docs call this out explicitly. The plugin parses those marker lines so
patch-based edits to the instructions file get the same cap.

## Context monitor — the faithful source found later

The first port dropped context monitoring because the opencode SDK `Message`
has no per-message `usage`. That's true, but the per-step **`step-finish`
part** in `opencode.db` DOES carry real tokens (`input`/`output`/`cache`). The
monitor reads the latest one for the session (via `bun:sqlite`, SDK fallback)
every 15 tool calls and warns when a checkpoint is crossed. It still never
reports a percentage or window — that genuinely can't be derived from the
transcript (same conclusion as the Claude side).

## Large-call detection

`find-large-turns.sh` flags calls abnormal for their own tool type against a
calibrated baseline. Rather than port the calibration file, the plugin keeps a
**running per-session average** per tool and flags a call > 8x it (after a few
samples), plus a hard Bash-output nudge since Bash is the biggest source.

## Relay instruction

Every injected block starts with `# <name>-inject: <kind>`. Because the
plugins' TUI toasts are off, `environment-snippet.md` (appended to
`environment.md` by `install.sh`) tells the model to relay those blocks to the
user. The markers are standardized so the model recognizes them instantly.