#!/usr/bin/env bash
# Remove everything install.sh added to the local opencode config.
#
#   ./uninstall.sh                 # targets ~/.config/opencode
#   OPENCODE_CONFIG=/path ./uninstall.sh
set -euo pipefail

DEST="${OPENCODE_CONFIG:-$HOME/.config/opencode}"

rm -f "$DEST"/agent/free-*.md
rm -rf "$DEST/skills/free-model-first"
rm -f "$DEST/instructions/free-model-first.md"
rm -f "$DEST/plugins/free-session-prefix.ts"

for CFG in "$DEST/opencode.jsonc" "$DEST/opencode.json"; do
  if [ -f "$CFG" ]; then
    sed -i '\#instructions/free-model-first.md#d' "$CFG"
  fi
done

CLAUDE="$DEST/instructions/claude-first.md"
if [ -f "$CLAUDE" ] && grep -qF 'free-model-first:begin' "$CLAUDE"; then
  sed -i '/<!-- free-model-first:begin -->/,/<!-- free-model-first:end -->/d' "$CLAUDE"
fi

printf 'Uninstalled. Restart opencode.\n'
