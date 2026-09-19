# opencode-free-model-first

Try the free opencode models on non-trivial work before spending the paid
main model. Each task gets up to **3 read-only free-model attempts**; if all
three are trash, the main model does the task. Rotation is per attempt, so
the next task starts on a different free model.

The chain is **free model -> main model**, which overrides the
`claude-first` rule for these tasks.

## How it works

1. A pure-bash script picks the next free model from a rotation cursor.
2. The trial runs through the opencode binary in an isolated, read-only
   agent: `opencode run --agent <free-*> --dir <workdir> --auto -- "<brief>"`.
3. The caller verifies the proposed answer/diff. Usable -> it is applied.
   Trash -> recorded and the next model is tried. After 3 trash, the main
   model handles it.

Read-only is enforced by the agent permissions (`edit: deny`, `task: deny`,
bash limited to read-only commands), so a trial can inspect the codebase but
never mutate it.

## Contents

```
agent/free-*.md                     one read-only agent per free model
instructions/free-model-first.md    always-on policy
skills/free-model-first/SKILL.md    full workflow
skills/free-model-first/free_models.sh   rotation state (pure bash)
install.sh / uninstall.sh
```

Free models covered: `big-pickle`, `ling-3.0-flash-fin-free`,
`mimo-v2.5-free`, `muse-spark-1.2/1.3-contributor-free`,
`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`.

## Install

```bash
./install.sh
```

Copies the agents, instruction and skill into `~/.config/opencode` (override
with `OPENCODE_CONFIG=...`), adds the instruction to the `instructions` array
of `opencode.jsonc`, and appends a marked precedence note to
`claude-first.md`. Re-running is safe.

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
opencode run --agent free-mimo --dir "$PWD" --auto -- "<self-contained brief>"
```

## Adding or removing a free model

Add/delete an `agent/free-*.md` (pin `model:` and keep the read-only
permission block). The script discovers the file automatically; no other
change needed.

## Notes

- `free-nemotron-ultra` and `free-nemotron-lightning` have been observed to
  time out; a timeout counts as trash and they rotate out after one attempt.
- Runtime rotation state (`.cursor`, `stats.tsv`) is created in the installed
  skill directory and is gitignored.

## Uninstall

```bash
./uninstall.sh
```
