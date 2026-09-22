#!/usr/bin/env bash
# Installs the 5 token-optimization hooks into an existing Claude Code
# setup: copies scripts/ into ~/.claude/scripts/, merges the hook wiring
# into ~/.claude/settings.json (backed up first, existing hooks for the
# same events are kept, not replaced), and appends claude-md-snippet.md
# into ~/.claude/CLAUDE.md inside a marker block (skipped on re-run so
# installing twice is safe).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SCRIPTS_DIR="$CLAUDE_DIR/scripts"
SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
MARKER_BEGIN="<!-- claude-token-optimization:begin -->"
MARKER_END="<!-- claude-token-optimization:end -->"

command -v jq >/dev/null 2>&1 || { echo "jq is required - install it first (e.g. apt/brew/pkg install jq)" >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo "bash is required" >&2; exit 1; }

mkdir -p "$SCRIPTS_DIR"
cp "$REPO_DIR"/scripts/*.sh "$SCRIPTS_DIR/"
chmod +x "$SCRIPTS_DIR"/*.sh
echo "Copied scripts to $SCRIPTS_DIR"

# --- settings.json: merge hooks arrays per event, don't touch anything else ---
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
BACKUP="$SETTINGS.bak.$(date +%s)"
cp "$SETTINGS" "$BACKUP"

jq -s '
  .[0] as $existing | .[1].hooks as $new |
  $existing
  | .hooks = (
      ($existing.hooks // {}) as $eh
      | ($eh + $new
         | keys_unsorted | unique) as $events
      | reduce $events[] as $ev
          ({}; .[$ev] = (($eh[$ev] // []) + ($new[$ev] // []) | unique))
    )
' "$SETTINGS" "$REPO_DIR/scripts/settings.json" > "$SETTINGS.tmp"
mv "$SETTINGS.tmp" "$SETTINGS"
echo "Merged hooks into $SETTINGS (previous version backed up at $BACKUP)"

# --- CLAUDE.md: append the terse rules snippet once, idempotent ---
touch "$CLAUDE_MD"
if grep -qF "$MARKER_BEGIN" "$CLAUDE_MD"; then
  echo "CLAUDE.md already has the claude-token-optimization block - skipped (edit it there directly, or remove the block between $MARKER_BEGIN/$MARKER_END and re-run to reinstall)"
else
  {
    echo ""
    echo "$MARKER_BEGIN"
    cat "$REPO_DIR/claude-md-snippet.md"
    echo "$MARKER_END"
  } >> "$CLAUDE_MD"
  echo "Appended the token-efficiency rules block to $CLAUDE_MD"
fi

cat <<'EOF'

Install complete. Optional next step: once you have a few real Claude
Code sessions, run this to measure your own per-tool token baseline
(used by find-large-turns.sh instead of a generic fallback):

    bash ~/.claude/scripts/calibrate-baseline.sh

To uninstall: remove the block between the claude-token-optimization
markers in ~/.claude/CLAUDE.md, remove the matching hook entries from
~/.claude/settings.json (or restore the settings.json.bak.* backup this
script made), and delete the *.sh files this script copied into
~/.claude/scripts/.
EOF
