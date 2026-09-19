# Free-model-first — task tool (overrides claude-first)

Free opencode models are available at zero cost. For non-trivial work, try
them as read-only trial subagents before spending the paid main model. The
trials run through opencode's **built-in task tool**, so they stay inside this
session instead of spawning extra processes. This takes precedence over the
`claude-first` rule: the chain is **free model -> main model**, not Claude.

Non-trivial = multi-file change, refactor, review, audit, research, or likely
more than a couple of tool calls. Skip for trivial edits, quick greps, and
direct questions.

## Loop (max 3 free attempts per task)

1. `bash ~/.config/opencode/skills/free-model-first/free_models.sh next`
   -> prints the next `free-*` agent name and advances the rotation cursor.
2. Call the **task tool** with `subagent_type` set to that agent name, passing
   a self-contained brief (goal, paths, constraints, how to verify). Free
   agents are read-only and return a proposed answer/diff.
3. Judge with the trash rubric below.
   - Usable -> verify it yourself, apply any patch with the edit tool, then
     `... free_models.sh ok <agent>`. Done.
   - Trash -> `... free_models.sh trash <agent>` and loop to step 1
     (the next attempt uses a different model).
4. After 3 trash attempts, do the task yourself with the main model and tell
   the user which free models failed.

Rotation is per attempt, so the next task also starts on a different model.

## Trash rubric

Trash if: wrong/irrelevant answer, invented paths/APIs/test results, patch
does not apply or breaks the build, incomplete or unverifiable, empty,
refused, errored, or the subagent never returned. Only accept a correct,
verified result — confidence is not evidence. Never let a free agent write
files; apply its patch yourself after review and run the tests/lint/build.

Full detail: the `free-model-first` skill.
