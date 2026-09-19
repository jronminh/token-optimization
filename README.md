# opencode-free-model-first

Try the free opencode models on non-trivial work before spending the paid
main model. Each task gets up to **3 free-model attempts**; if all three are
trash, the main model does the task. Rotation is per attempt, so the next task
starts on a different free model.

The chain is **free model -> main model**, which overrides the
`claude-first` rule for these tasks.

## Variants

Both variants share the same `free-*` agents and the same pure-bash
rotation script. Only the way a trial is invoked differs.

| variant | how a trial runs | notes |
| --- | --- | --- |
| `task-tool` **(default)** | opencode's built-in task tool with `subagent_type: free-*` | stays inside the session; no extra process, no scratch files |
| `opencode-run` | `opencode run --agent free-*` via bash | each trial is an isolated process; output is redirected to a scratch file |

## How it works

1. `lib/free_models.sh` picks the next free model from a rotation cursor.
2. The trial runs in the variant's chosen way, as a trial agent that may
   read/edit/write files and run a limited command set.
3. The caller verifies the ACTUAL workspace (tests/lint/build, `git diff`).
   Usable -> kept. Trash -> its edits reverted and the next model is tried.
   After 3 trash, the main model handles it.

The agents are not trusted: `edit`/`write` are allowed so they can finish real
work, `task` is denied, and bash is a limited allowlist of read/dev commands.
Verification and the revert belong to the caller.

## Contents

```
agent/free-*.md                     one trial agent per free model (shared)
lib/free_models.sh                  rotation state (pure bash, shared)
plugins/free-session-prefix.ts      tags trial sessions with a "[free] " prefix
variants/task-tool/                 policy + skill for the built-in task tool
variants/opencode-run/              policy + skill for the subprocess path
install.sh / uninstall.sh
```

Free models covered: `big-pickle`, `ling-3.0-flash-fin-free`,
`mimo-v2.5-free`, `muse-spark-1.2/1.3-contributor-free`,
`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`.

## Install

```bash
./install.sh              # task-tool (default)
./install.sh opencode-run # subprocess variant
```

Copies the agents, the variant's instruction and skill, and the rotation
script into `~/.config/opencode` (override with `OPENCODE_CONFIG=...`), adds
the instruction to the `instructions` array of `opencode.jsonc`, and appends a
marked precedence note to `claude-first.md`. Re-running is safe, and
installing one variant replaces the other.

**Restart opencode** afterwards: config is loaded once at startup.

## Usage

The policy is always-on, so the agent follows it automatically. The rotation
script is also usable by hand:

```bash
s=~/.config/opencode/skills/free-model-first/free_models.sh
bash "$s" next      # print + advance to the next free agent
bash "$s" peek      # print without advancing
bash "$s" ok <a>    # record a usable result
bash "$s" trash <a> # record a trash result
bash "$s" status    # cursor + per-model ok/trash counts
bash "$s" reset     # zero the cursor and counts
```

Run a trial directly:

```bash
# task-tool variant: call the task tool with subagent_type "free-mimo"
# opencode-run variant:
opencode run --agent free-mimo --dir "$PWD" --auto -- "<self-contained brief>"
```

## Session history

`plugins/free-session-prefix.ts` retitles every trial session with a `[free] `
prefix, so the sessions spawned by the policy can be filtered out of session
history. It matches any session whose agent starts with `free-` (both the
task-tool subagents and `opencode run --agent free-*`), and re-applies the
prefix if opencode's title generator later rewrites the title. It is cosmetic
only — failures are swallowed.

The built-in task tool already appends `(@<agent> subagent)` to child session
titles, so `(@free-` also works as a filter even without the plugin.

Plugins load at opencode startup, so a restart is required before the prefix
applies to sessions created in an already-running instance.

## Adding or removing a free model

Add/delete an `agent/free-*.md` (pin `model:` and keep the edit/write +
limited-bash permission block). The script discovers the file automatically;
no other change needed.

## Notes

- **Cost discipline**: the free models cost nothing, but every step re-reads
  the whole context. Measured trials used 1-3 steps, ~11k input per attempt,
  ~11k cache-read per extra step, and negligible output — so step count is the
  real driver. Agents cap at `steps: 20`, and the briefs ask for minimal reads
  and no large dumps. If a task clearly needs heavy exploration, skip the trial.
- `free-nemotron-ultra` and `free-nemotron-lightning` have been observed to
  time out; a timeout counts as trash and they rotate out after one attempt.
- Runtime rotation state (`.cursor`, `stats.tsv`) is created in the installed
  skill directory and is gitignored.

## Uninstall

```bash
./uninstall.sh
```
