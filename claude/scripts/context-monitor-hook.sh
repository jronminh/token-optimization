#!/usr/bin/env bash
# PostToolUse hook: every N tool calls in a session, check REAL token usage
# (exact, from API usage in the transcript) and remind the user to run
# /context themselves once usage crosses a new checkpoint.
#
# Deliberately does NOT compute a percentage or guess the context window -
# a prior version did ("1M if usage already exceeds 200k, else 200k") and
# was proven wrong on a live session: real /context reported 16% of a 1M
# window at a point this heuristic called 82% of an assumed 200k window.
# Only /context (interactive-only, not scriptable) knows the true window.
# So instead of a possibly-false alarm, this notifies once per raw-token
# checkpoint crossed and asks the user to check the real number themselves.
# See ~/claude-token-optimization/docs/session-stats.md for the incident.
set -euo pipefail

N=15
SCRIPT_DIR="$HOME/.claude/scripts"
# Linear early on (sessions commonly land 100-300k), coarser later so a
# long/extended-window session doesn't get spammed every 100k.
CHECKPOINTS=(100000 200000 300000 450000 600000 800000 1000000 1300000 1600000 2000000)
# Below this, a crossed checkpoint is recorded but not surfaced - still just
# internal bookkeeping, not yet worth interrupting the user about. At/above
# it, usage is high enough to genuinely risk an imminent compact, so the
# hook actually speaks up.
LOUD_THRESHOLD=1000000

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')

[ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT" ] || exit 0

COUNT_DIR="$HOME/.claude/session-env/$SESSION_ID"
mkdir -p "$COUNT_DIR"
COUNT_FILE="$COUNT_DIR/context-monitor-count"
LAST_CKPT_FILE="$COUNT_DIR/context-monitor-last-checkpoint"

COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$COUNT_FILE"

# Only actually check every Nth tool call
[ $(( COUNT % N )) -eq 0 ] || exit 0

RESULT=$(bash "$SCRIPT_DIR/check-context.sh" "$TRANSCRIPT" 2>/dev/null || true)
TOKENS=$(printf '%s' "$RESULT" | grep -oE 'tokens: [0-9]+' | grep -oE '[0-9]+' | head -1)
TOKENS="${TOKENS:-0}"

LAST_CKPT=$(cat "$LAST_CKPT_FILE" 2>/dev/null || echo 0)

NEW_CKPT=0
for c in "${CHECKPOINTS[@]}"; do
  if [ "$TOKENS" -ge "$c" ] && [ "$c" -gt "$LAST_CKPT" ]; then
    NEW_CKPT="$c"
  fi
done

[ "$NEW_CKPT" -gt 0 ] || exit 0

echo "$NEW_CKPT" > "$LAST_CKPT_FILE"

# Below LOUD_THRESHOLD: silent bookkeeping only, nothing surfaced.
[ "$NEW_CKPT" -ge "$LOUD_THRESHOLD" ] || exit 0

LARGE=$(bash "$SCRIPT_DIR/find-large-turns.sh" "" 5 "$TRANSCRIPT" 2>/dev/null || true)

CTX="Automatic context check (every $N tool calls): real token usage this session (exact, from API usage) just crossed ${NEW_CKPT} tokens (currently ~${TOKENS}) - high enough to risk an imminent compact. The true context window can't be determined from the transcript, so no percentage is given - warn the user directly about this milestone. Biggest individual tool calls/messages by estimated token size:
${LARGE:-none found}"

jq -n --arg ctx "$CTX" --arg msg "Context: just crossed ${NEW_CKPT} real tokens (~${TOKENS})." \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
