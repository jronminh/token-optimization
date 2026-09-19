---
name: free-model-first
description: Route non-trivial work through free opencode models before spending the paid main model, using the built-in task tool. Use when starting a multi-file change, refactor, code review, or research task, or when the user mentions free models, trying a free model first, or saving provider credits.
---

# Free-model-first — task tool

Try a free model as a read-only trial subagent before doing non-trivial work
yourself. Trials run through opencode's **built-in task tool**, so they stay
inside this session: no extra process, no scratch files. Accept a result only
after you have verified it. After 3 trash attempts, do the task yourself with
the main model. Rotation is per attempt, so the next task starts on a
different free model than the last one.

This overrides the `claude-first` rule: for these tasks the chain is
**free model -> main model**. Do not route them to Claude.

## Scope

Apply to non-trivial tasks: multi-file changes, refactors, reviews, audits,
research, or anything likely to need more than a couple of tool calls.

Skip it for trivial work (single-line edits, quick greps/searches, direct
questions) — delegation costs more latency than it saves.

## The loop

Run at most 3 free attempts per task.

1. Pick the agent (pure-bash rotation):
   `bash ~/.config/opencode/skills/free-model-first/free_models.sh next`
   Prints the next `free-*` agent name and advances the cursor.
2. Call the **task tool** with `subagent_type` set to that agent name. Write a
   self-contained brief: goal, relevant paths, constraints, and how the result
   will be verified. The subagent is read-only (edit denied, bash restricted),
   so it returns a proposed answer/diff, not edits.
3. Judge the result against the rubric below.
   - Usable: verify it, apply it yourself if it is a patch, then
     `... free_models.sh ok <agent>`. Done.
   - Trash: `... free_models.sh trash <agent>` and loop to step 1 (the next
     attempt uses a different model).
4. After 3 trash attempts, do the task yourself with the main model. Tell the
   user briefly which free models were tried and that you fell back.

An error, empty response, refusal, or a subagent that never returns counts as
trash. (Observed: `free-nemotron-ultra` and `free-nemotron-lightning` often
time out; they rotate out after one failed attempt each.)

## Trash rubric

Call an attempt trash if any of these hold:

- It did not address the actual task, or answered a different question.
- It invented file paths, APIs, function names, or test results.
- The proposed patch does not apply, references nonexistent code, or would
  break the build.
- The answer is incomplete, hand-wavy, or you cannot verify it.
- It returned nothing, refused, errored, or timed out.

Only accept when the proposal is correct and you have verified it. A
confident tone is not evidence.

## Verifying before accepting

- Read the proposed diff/answer against the real files.
- Apply it with the edit tool (never let a free agent write directly).
- Run the relevant tests, lint, or build command.
- If verification fails, record `trash` and continue the loop.

## State

`free_models.sh` auto-discovers every `free-*` agent and stores the cursor
and per-agent ok/trash counts next to itself. Inspect with `... status`, zero
it with `... reset`.

To add or remove a free model, add/delete its
`~/.config/opencode/agent/free-*.md` file; the script picks it up
automatically. Each agent pins one free model and the read-only permission
set, and its `mode: all` lets it be called both through the task tool and as
a standalone `opencode run` agent.

The same `free-*` agents can also be run through the opencode binary as
isolated processes (`opencode run --agent <free-*>`); see the `opencode-run`
variant if you prefer that.
