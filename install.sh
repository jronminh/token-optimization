#!/usr/bin/env bash
# Install the free-model-first mechanism into the local opencode config.
#
#   ./install.sh                 # installs into ~/.config/opencode
#   OPENCODE_CONFIG=/path ./install.sh
#
# Idempotent: re-running it will not duplicate anything.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OPENCODE_CONFIG:-$HOME/.config/opencode}"

if [ ! -d "$DEST" ]; then
  printf 'opencode config dir not found: %s\n' "$DEST" >&2
  printf 'Set OPENCODE_CONFIG to override.\n' >&2
  exit 1
fi

mkdir -p "$DEST/agent" "$DEST/instructions" "$DEST/skills/free-model-first"

cp "$SRC"/agent/free-*.md "$DEST/agent/"
cp "$SRC/instructions/free-model-first.md" "$DEST/instructions/"
cp "$SRC/skills/free-model-first/SKILL.md" "$DEST/skills/free-model-first/"
cp "$SRC/skills/free-model-first/free_models.sh" "$DEST/skills/free-model-first/"
chmod +x "$DEST/skills/free-model-first/free_models.sh"

INSTR="$DEST/instructions/free-model-first.md"

# --- wire the instruction into opencode.json(c) ----------------------------
CFG=""
for candidate in "$DEST/opencode.jsonc" "$DEST/opencode.json"; do
  if [ -f "$candidate" ]; then CFG="$candidate"; break; fi
done

if [ -z "$CFG" ]; then
  printf 'No opencode.json(c) in %s; add this to "instructions" manually:\n  %s\n' "$DEST" "$INSTR"
elif grep -qF "$INSTR" "$CFG"; then
  printf 'instruction already present in %s\n' "$CFG"
elif awk -v p="$INSTR" '
      /"instructions"[[:space:]]*:[[:space:]]*\[/ { if (index($0, "]")) single = 1; found = 1 }
      END { exit (found && !single) ? 0 : 1 }
    ' "$CFG"; then
  awk -v p="$INSTR" '
    { print }
    !done && /"instructions"[[:space:]]*:[[:space:]]*\[/ { print "    \"" p "\","; done = 1 }
  ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
  printf 'added instruction to %s\n' "$CFG"
else
  printf 'No safely-editable "instructions" array in %s; add manually:\n  %s\n' "$CFG" "$INSTR"
fi

# --- mark free-model-first precedence in claude-first.md -------------------
CLAUDE="$DEST/instructions/claude-first.md"
if [ -f "$CLAUDE" ]; then
  if grep -qF 'free-model-first:begin' "$CLAUDE"; then
    printf 'claude-first precedence note already present\n'
  else
    cat >> "$CLAUDE" <<'EOF'

<!-- free-model-first:begin -->
**Exception — free models come first.** Non-trivial tasks are first attempted
on the free opencode models per `free-model-first.md`; only after 3 trash
attempts does the main model handle it. Those tasks are NOT delegated to
Claude. See that file for the precedence rules.
<!-- free-model-first:end -->
EOF
    printf 'added precedence note to claude-first.md\n'
  fi
fi

printf '\nInstalled. Restart opencode to load the new agents and instruction.\n'
