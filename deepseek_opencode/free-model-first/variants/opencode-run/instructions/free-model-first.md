# Free-model-first (overrides claude-first)

Free opencode models are available at zero cost. For non-trivial work, try
them as trial workers before spending the paid main model. This takes
precedence over the `claude-first` rule: the chain is **free model -> main
model**, not Claude.

Non-trivial = multi-file change, refactor, review, audit, research, or likely
more than a couple of tool calls. Skip for trivial edits, quick greps, and
direct questions.

## Loop (max 3 free attempts per task)

1. `bash ~/.config/opencode/skills/free-model-first/free_models.sh next`
   -> prints the next `free-*` agent name and advances the rotation cursor.
2. Run the trial through the opencode binary (free agents may edit/write files
   and run a limited command set):
   `opencode run --agent <agent> --dir <workdir> --auto -- "<self-contained brief>" > ~/.cache/opencode-tmp/opencode/free-trial.txt 2>&1`
   Use a generous bash timeout (e.g. 180000 ms) and read the file back.
3. Judge by checking the ACTUAL workspace, not the agent's summary (read the
   changed files, run tests/lint/build, `git diff` if there is a repo).
   - Usable -> `... free_models.sh ok <agent>`. Done.
   - Trash -> revert its edits, `... free_models.sh trash <agent>`, and loop
     to step 1 (the next attempt uses a different model).
4. After 3 trash attempts, do the task yourself with the main model and tell
   the user which free models failed.

Rotation is per attempt, so the next task also starts on a different model.

## Trash rubric

Trash if: wrong/irrelevant result, invented paths/APIs/test results, broken
build or failing tests, incomplete or unverifiable, empty, refused, errored,
or timed out. Confidence is not evidence — check the workspace yourself.
Revert any bad edits before the next attempt.

Full detail: the `free-model-first` skill.
