#!/usr/bin/env bash
# Report this session's REAL token usage from its transcript's actual
# reported API usage (input_tokens + cache_read + cache_creation on the
# most recent assistant message with a usage block) - not a byte-size
# heuristic on the whole .jsonl file.
#
# Deliberately does NOT guess or report a percentage of the context
# window. Verified in practice (2026-09-16): the true window (200k vs
# extended/1M) cannot be determined from the transcript - there is no
# window-size field in the usage block - and a prior version of this
# script that auto-detected "1M if usage already exceeds 200k, else
# 200k" was proven wrong on a live session (real /context reported 16%
# of a 1M window at a point where this heuristic reported 82% of an
# assumed 200k window - a ~5x overstatement). Only the interactive
# `/context` command knows the real window.
#
# Usage: check-context.sh [transcript_path]
# If transcript_path is omitted, falls back to the most recently modified
# *.jsonl across all projects (may be wrong with multiple concurrent sessions).
set -euo pipefail

LATEST="${1:-}"
PROJ_DIR="$HOME/.claude/projects"

if [ -z "$LATEST" ]; then
  LATEST=$(find "$PROJ_DIR" -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
fi

if [ -z "${LATEST:-}" ] || [ ! -f "$LATEST" ]; then
  echo "no transcript found"
  exit 0
fi

USAGE_LINE=$(tac "$LATEST" 2>/dev/null | awk '/"usage":\{/ && !/"model":"<synthetic>"/ { print; exit }' || true)
TOKENS=0
if [ -n "$USAGE_LINE" ]; then
  TOKENS=$(printf '%s' "$USAGE_LINE" | jq -r '
    (.message.usage.input_tokens // 0)
    + (.message.usage.cache_read_input_tokens // 0)
    + (.message.usage.cache_creation_input_tokens // 0)
  ' 2>/dev/null || echo 0)
  TOKENS="${TOKENS:-0}"
fi

echo "transcript: $LATEST"
echo "tokens: $TOKENS"
echo "(true window can't be determined from the transcript - no percentage/window is reported)"
