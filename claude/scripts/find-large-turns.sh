#!/usr/bin/env bash
# Flag individual messages/tool calls in the current transcript that are
# abnormal for THEIR OWN tool type - not one flat threshold for everything.
# Per-tool baseline avg tokens/call comes from calibrate-baseline.sh's
# output (BASELINE_FILE below) if it exists - run that script once to
# measure your own real usage pattern instead of trusting a number tuned
# on someone else's workload (a heavy WebSearch user and a heavy Bash user
# have very different real averages). Falls back to one flat DEFAULT_AVG
# for every tool when no calibration file is present yet.
# "Abnormal" = MULTIPLIER x that tool's own average (default 8x). A flat
# THRESHOLD arg still works and overrides this entirely (backward compat).
#
# Usage: find-large-turns.sh [threshold_tokens|""] [top_n] [transcript_path]
# threshold_tokens: a number forces the OLD flat-threshold-for-everything
#   behavior; "" (or omitted) uses the per-tool baseline*MULTIPLIER default.
set -euo pipefail

THRESHOLD="${1:-}"
TOPN="${2:-5}"
PROJ_DIR="$HOME/.claude/projects"
BASELINE_FILE="$HOME/.claude/session-env/baseline-tokens.json"
MULTIPLIER=8

TRANSCRIPT="${3:-}"
if [ -z "$TRANSCRIPT" ]; then
  TRANSCRIPT=$(find "$PROJ_DIR" -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  echo "no transcript found"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found — cannot inspect per-call sizes"
  exit 0
fi

# chars->token heuristic: 3.5 chars/token (matches check-md-size.sh)
DEFAULT_AVG=400   # fallback avg tok/call when no calibration file, or for
                   # tool types the calibration file hasn't seen yet
BASELINE_JSON=$(cat "$BASELINE_FILE" 2>/dev/null || echo '{}')
FLAT_MIN_CHARS=""
if [ -n "$THRESHOLD" ]; then
  FLAT_MIN_CHARS=$(( THRESHOLD * 7 / 2 ))
fi

jq -s -r \
  --argjson multiplier "$MULTIPLIER" \
  --argjson defaultAvg "$DEFAULT_AVG" \
  --argjson avgs "$BASELINE_JSON" \
  --arg flatMinChars "$FLAT_MIN_CHARS" \
  '
  def toolmap:
    [ .[] | select(.type=="assistant") | (.message.content // [])[]?
      | select(.type=="tool_use") | {(.id): .name} ] | add // {};
  . as $all
  | (toolmap) as $map
  | $all[]
  | select(.type=="assistant" or .type=="user")
  | . as $e
  | (($e.message.content // []) | if type=="array" then .[] else empty end) as $item
  | ($item.type // "") as $ctype
  | (
      if $ctype=="tool_use" then ($item.input | tostring)
      elif $ctype=="tool_result" then
        (if ($item.content|type)=="array"
         then ([$item.content[]?.text? // empty] | join(" "))
         else ($item.content // "" | tostring) end)
      elif $ctype=="text" then ($item.text // "")
      elif $ctype=="thinking" then ($item.thinking // "")
      else "" end
    ) as $text
  | (if $ctype=="tool_result" then ($map[$item.tool_use_id] // "?")
     elif $ctype=="tool_use" then ($item.name // "-")
     else "text" end) as $name
  | (if $flatMinChars != "" then ($flatMinChars | tonumber)
     else (($avgs[$name] // $defaultAvg) * $multiplier * 3.5 | floor)
     end) as $minchars
  | select(($text|length) >= $minchars)
  | ($text|length) as $len
  | [$len, $e.type, $ctype, $name, ($text | gsub("[\n\t]";" ") | .[0:100])]
  | @tsv
  ' "$TRANSCRIPT" \
  | sort -rn -k1,1 \
  | head -n "$TOPN" \
  | awk -F'\t' 'BEGIN{OFS="\t"} {
      tokens=int($1*2/7);
      printf "~%d tok  [%s/%s %s]  %s\n", tokens, $2, $3, $4, $5
    }'
