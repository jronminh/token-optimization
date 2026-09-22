#!/usr/bin/env bash
# Measures this installation's own average tokens/call per tool type from
# real transcripts under ~/.claude/projects, and writes the result as a
# baseline table find-large-turns.sh reads instead of using one hardcoded
# from someone else's usage pattern - workload shape varies a lot (a heavy
# WebSearch user and a heavy Bash user have very different real averages).
# Uses chars/3.5 (jq's unicode-aware `length`), the same estimate ratio as
# find-large-turns.sh and check-md-size.sh.
#
# Usage: calibrate-baseline.sh [output_path]
# Re-run any time to refresh the baseline as your usage pattern changes.
set -euo pipefail

OUT="${1:-$HOME/.claude/session-env/baseline-tokens.json}"
PROJ_DIR="$HOME/.claude/projects"
mkdir -p "$(dirname "$OUT")"

command -v jq >/dev/null 2>&1 || { echo "jq not found - cannot calibrate" >&2; exit 1; }

mapfile -t TRANSCRIPTS < <(find "$PROJ_DIR" -maxdepth 2 -name '*.jsonl' 2>/dev/null)
[ "${#TRANSCRIPTS[@]}" -gt 0 ] || { echo "no transcripts found under $PROJ_DIR - nothing to calibrate from" >&2; exit 1; }

jq -s -r '
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
  | select($text != "")
  | (if $ctype=="tool_result" then ($map[$item.tool_use_id] // "?")
     elif $ctype=="tool_use" then ($item.name // "-")
     else "text" end) as $name
  | [$name, ($text|length)]
  | @tsv
' "${TRANSCRIPTS[@]}" \
  | awk -F'\t' '
      { sum[$1] += $2; n[$1]++ }
      END {
        printf "{"
        first = 1
        for (k in sum) {
          tok = int(sum[k] / n[k] * 2 / 7)   # chars/3.5, matches find-large-turns.sh
          if (!first) printf ","
          printf "\n  \"%s\": %d", k, tok
          first = 0
        }
        printf "\n}\n"
      }
    ' > "$OUT"

echo "Calibrated $(jq 'length' "$OUT") tool baselines from ${#TRANSCRIPTS[@]} transcript(s) -> $OUT" >&2
cat "$OUT"
