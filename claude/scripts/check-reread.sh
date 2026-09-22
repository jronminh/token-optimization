#!/usr/bin/env bash
# PreToolUse hook (Read): warn (don't block) if this file has already been
# Read earlier in the same session. Evidence (session-stats.md, 2026-09-16,
# real transcript analysis) shows this happens in practice, up to 16x in a
# single session, despite the "avoid re-reading" rule already in CLAUDE.md -
# this catches it live instead of only in after-the-fact analysis.
set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -n "$SESSION_ID" ] && [ -n "$FILE_PATH" ] || exit 0

LOG_DIR="$HOME/.claude/session-env/$SESSION_ID"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/read-files-log"

PRIOR=$(grep -Fxc "$FILE_PATH" "$LOG_FILE" 2>/dev/null || true)
PRIOR="${PRIOR:-0}"

# Record this attempt for next time - after counting PRIOR, so the message
# below reports how many times it was read BEFORE this call.
echo "$FILE_PATH" >> "$LOG_FILE"

[ "$PRIOR" -ge 1 ] || exit 0

N=$(( PRIOR + 1 ))

# Exponential backoff: warn on read #2, #4, #8, #16... not every single
# repeat - a file edited/reread many times in one session (observed: one
# note file hit ~15 reads) doesn't need the identical warning re-injected
# on every one once the point has already been made.
(( (N & (N - 1)) == 0 )) || exit 0

CTX="'$FILE_PATH': read #$N this session. Prefer grep -n -A<N> -B<N> <anchor> over a full re-Read."

jq -n --arg ctx "$CTX" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
