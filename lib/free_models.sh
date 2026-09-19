#!/usr/bin/env bash
# Free-model rotation state for the free-model-first policy.
#
# Discovers every read-only trial agent matching ~/.config/opencode/agent/free-*.md
# and rotates through them, one per attempt, so a new task never starts on the
# model that just failed. Pure bash, no external tools beyond coreutils.
#
# Usage:
#   free_models.sh next          # print next agent name AND advance the cursor
#   free_models.sh peek          # print next agent name WITHOUT advancing
#   free_models.sh ok [agent]    # record a usable result (default: last 'next')
#   free_models.sh trash [agent] # record a trash result  (default: last 'next')
#   free_models.sh status        # cursor + per-agent ok/trash counts
#   free_models.sh reset         # zero the cursor and all counts
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${HOME}/.config/opencode/agent"
INDEX_FILE="${SELF_DIR}/.cursor"
STATS_FILE="${SELF_DIR}/stats.tsv"

models() {
  local f base
  for f in "${AGENT_DIR}"/free-*.md; do
    [ -e "${f}" ] || continue
    base="${f##*/}"
    printf '%s\n' "${base%.md}"
  done
}

read_index() {
  if [ -f "${INDEX_FILE}" ]; then
    cat "${INDEX_FILE}"
  else
    printf '0\n'
  fi
}

write_index() {
  printf '%s\n' "$1" > "${INDEX_FILE}"
}

cmd_next() {
  local -a m=($(models))
  local n=${#m[@]}
  if [ "${n}" -eq 0 ]; then
    printf 'ERROR: no free-*.md agents found in %s\n' "${AGENT_DIR}" >&2
    return 2
  fi
  local i
  i="$(read_index)"
  printf '%s\n' "${m[$((i % n))]}"
  write_index "$(((i + 1) % n))"
}

cmd_peek() {
  local -a m=($(models))
  local n=${#m[@]}
  if [ "${n}" -eq 0 ]; then
    printf 'ERROR: no free-*.md agents found in %s\n' "${AGENT_DIR}" >&2
    return 2
  fi
  printf '%s\n' "${m[$(($(read_index) % n))]}"
}

cmd_record() {
  local action="$1" model="${2:-}"
  local -a m=($(models))
  local n=${#m[@]}
  if [ "${n}" -eq 0 ]; then
    printf 'ERROR: no free-*.md agents found in %s\n' "${AGENT_DIR}" >&2
    return 2
  fi
  if [ -z "${model}" ]; then
    model="${m[$(( ($(read_index) - 1 + n) % n ))]}"
  fi
  touch "${STATS_FILE}"
  awk -v m="${model}" -v a="${action}" '
    $1 == m { if (a == "ok") $2++; else $3++; seen = 1 }
    { print }
    END { if (!seen) print m, (a == "ok" ? 1 : 0), (a == "trash" ? 1 : 0) }
  ' "${STATS_FILE}" > "${STATS_FILE}.tmp"
  mv "${STATS_FILE}.tmp" "${STATS_FILE}"
  printf '%s: %s recorded\n' "${model}" "${action}"
}

cmd_status() {
  local -a m=($(models))
  local n=${#m[@]}
  if [ "${n}" -eq 0 ]; then
    printf 'ERROR: no free-*.md agents found in %s\n' "${AGENT_DIR}" >&2
    return 2
  fi
  local -A ok=() tr=()
  if [ -f "${STATS_FILE}" ]; then
    local a o t
    while read -r a o t; do
      [ -n "${a:-}" ] || continue
      ok["${a}"]="${o:-0}"
      tr["${a}"]="${t:-0}"
    done < "${STATS_FILE}"
  fi
  printf 'models: %d   next: %s\n' "${n}" "${m[$(($(read_index) % n))]}"
  local x
  for x in "${m[@]}"; do
    printf '  %-26s ok=%s trash=%s\n' "${x}" "${ok[${x}]:-0}" "${tr[${x}]:-0}"
  done
}

cmd_reset() {
  rm -f "${INDEX_FILE}" "${STATS_FILE}"
  printf 'reset\n'
}

main() {
  local cmd="${1:-status}"
  case "${cmd}" in
    next)  cmd_next ;;
    peek)  cmd_peek ;;
    ok)    cmd_record ok "${2:-}" ;;
    trash) cmd_record trash "${2:-}" ;;
    status) cmd_status ;;
    reset) cmd_reset ;;
    *) sed -n '2,16p' "${BASH_SOURCE[0]}"; return 2 ;;
  esac
}

main "$@"
