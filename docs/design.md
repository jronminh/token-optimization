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

## Dropped features (honest, not hidden)

- `context-monitor` / `check-context.sh`: read REAL per-message API `usage`
  from the transcript; the opencode SDK `Message` has no per-message `usage`
  field, so there's no faithful source. Skipped rather than faked.
- `find-large-turns.sh` / per-tool baseline calibration: needs the same
  token-usage source to detect abnormal calls, so it doesn't port either.