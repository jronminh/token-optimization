# token-optimization

Token-cost tooling for AI coding assistants, split by assistant:

- **`deepseek_opencode/`** — for [opencode](https://opencode.ai) with a DeepSeek
  main model:
  - `token-optimization/` — plugins that warn on wasteful token use and report
    spend (`budget.ts`, `token-optimization.ts`), plus `budget.json` for the
    balance/spend thresholds.
  - `free-model-first/` — route non-trivial work through the free opencode
    models before spending the paid main model (`agent/free-*.md`, the
    `free_models.sh` rotation, the policy skill).
- **`claude/`** — Claude Code hooks that do the same job for Claude.

Each folder keeps its own `install.sh` and README (merged here with history
intact). The opencode config keys that aren't owned by an installer — cheap
`small_model`, reasoning effort, per-agent `steps` — are shown in
`deepseek_opencode/opencode-config.example.jsonc`.

## Install

```sh
deepseek_opencode/token-optimization/install.sh   # budget + token plugins
deepseek_opencode/free-model-first/install.sh     # free agents + rotation + skill
claude/install.sh                                 # Claude Code hooks
```

## Origin

Merged, with history preserved, from three repos:

- `opencode-token-optimization`
- `opencode-free-model-first`
- `claude-token-optimization`
