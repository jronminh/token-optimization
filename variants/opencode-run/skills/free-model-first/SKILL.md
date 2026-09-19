---
name: free-model-first
description: Route non-trivial work through free opencode models before spending the paid main model. Use when starting a multi-file change, refactor, code review, or research task, or when the user mentions free models, trying a free model first, or saving provider credits.
---

# Free-model-first

Try a free model as a trial worker before doing non-trivial work yourself.
Trials run through the `opencode` binary in bash. Accept a result only after
you have verified it in the workspace. After 3 trash attempts, do the task
yourself with the main model. Rotation is per attempt, so the next task starts
on a different free model than the last one.

This overrides the `claude-first` rule: for these tasks the chain is
**free model -> main model**. Do not route them to Claude.

## Scope

Apply to non-trivial tasks: multi-file changes, refactors, reviews, audits,
research, or anything likely to need more than a couple of tool calls.

Skip it for trivial work (single-line edits, quick greps/searches, direct
questions) — delegation costs more latency than it saves.

## What the free agents may do

They may read, search, edit and write files, and run a limited command set
(common read/dev commands; see `~/.config/opencode/agent/free-*.md`). They are
not trusted: you own verification and the revert.

## The loop

Run at most 3 free attempts per task.

1. Pick the agent (pure-bash rotation):
   `bash ~/.config/opencode/skills/free-model-first/free_models.sh next`
   Prints the next `free-*` agent name and advances the cursor.
2. Run the trial through the opencode binary. Write a self-contained brief
   (goal, relevant paths, constraints, how the result will be verified) and
   redirect output to a scratch file so it does not flood context:

   ```bash
   opencode run --agent <agent> --dir <workdir> --auto -- "<brief>" \
     > ~/.cache/opencode-tmp/opencode/free-trial.txt 2>&1
   ```

   Read the scratch file back. Set the bash tool timeout generously (e.g.
   180000 ms); free models can be slow.
3. Judge by checking the ACTUAL workspace, not the agent's summary: read the
   changed files, run the tests/lint/build, and check `git diff` when there is
   a repo.
   - Usable: `... free_models.sh ok <agent>`. Done.
   - Trash: revert its edits, `... free_models.sh trash <agent>`, and loop to
     step 1 (the next attempt uses a different model).
4. After 3 trash attempts, do the task yourself with the main model. Tell the
   user briefly which free models were tried and that you fell back.

A timeout, error, auth failure, rate limit, or empty/refused response counts
as trash. (Observed: `free-nemotron-ultra` and `free-nemotron-lightning`
often time out; they will rotate out after one failed attempt each.)

## Trash rubric

Call an attempt trash if any of these hold:

- It did not address the actual task, or answered a different question.
- It invented file paths, APIs, function names, or test results.
- Its edits break the build or leave tests failing.
- The result is incomplete, hand-wavy, or you cannot verify it.
- It returned nothing, refused, hit an error, or timed out.

Only accept when the workspace is correct and you have verified it. A
confident tone is not evidence.

## Cost discipline

The free models cost nothing, but each step re-reads the whole context, so
step count is the real cost driver (measured: ~11k input per attempt, ~11k
cache-read per extra step, output negligible). Keep attempts cheap: bound the
brief, tell the agent not to re-read files or dump large output, and rely on
the per-agent `steps: 20` limit. If a task clearly needs many steps or heavy
exploration, skip the trial and do it yourself.

## State

`free_models.sh` auto-discovers every `free-*` agent and stores the cursor
and per-agent ok/trash counts next to itself. Inspect with `... status`, zero
it with `... reset`.

To add or remove a free model, add/delete its
`~/.config/opencode/agent/free-*.md` file; the script picks it up
automatically. Each agent pins one free model and its permission set
(edit/write allowed, limited bash, `steps: 20`).

The same `free-*` agents can also be called through the task tool as native
subagents; prefer the `opencode run` path above when you want the trial fully
isolated in its own process.
