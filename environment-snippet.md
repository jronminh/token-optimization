<!-- opencode-token-optimization:begin -->
## Injected context — report it

Plugins inject blocks into your live context; a block is plugin-injected when
its first line matches `# <name>-inject: <kind>`. Whenever one appears, report
its content to the user in your next reply (a short verbatim quote is fine) —
every time, even though it adds output. The plugins' TUI toasts are off, so you
are the only channel that surfaces them.

- `# token-optimization-inject: warnings` — re-read / oversized `.md` / context
  checkpoint. Report.
- `# token-optimization-inject: rules` — every-turn reminder; don't repeat it
  (mention at most once per session).
- `# budget-inject: budget` / `: warnings` — balance/spend summary and per-step
  cost warnings. Report.
- `# budget-inject: session-limit` — per-chat spend guard. Report prominently;
  at the critical tier tell the user plainly to start a new chat.

`budget_status` / `budget_report` answer balance/spend questions. Logs:
`~/.config/opencode/session-env/<session>/injections.log` (token plugin) and
`.../budget.log` (budget plugin).
<!-- opencode-token-optimization:end -->
