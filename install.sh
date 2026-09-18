#!/usr/bin/env bash
# Installs the opencode token-optimization plugin into
# ~/.config/opencode/plugins/ (loaded by opencode at every session start) and
# ensures @opencode-ai/plugin is declared in the config directory's
# package.json (opencode runs `bun install` there at startup).
# Idempotent: re-running overwrites the plugin with its current version and
# leaves an existing dependency entry untouched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
PLUGIN_SRC="$REPO_DIR/plugin/token-optimization.ts"

command -v jq >/dev/null 2>&1 || { echo "jq is required - install it first (e.g. apt/brew/pkg install jq)" >&2; exit 1; }

mkdir -p "$PLUGIN_DIR"
cp "$PLUGIN_SRC" "$PLUGIN_DIR/token-optimization.ts"
echo "Installed plugin to $PLUGIN_DIR/token-optimization.ts"

# --- package.json: merge in the plugin dep, touch nothing else ---
PKG="$CONFIG_DIR/package.json"
if [ -f "$PKG" ]; then
  jq -s '
    .[0] as $e
    | ($e.dependencies // {}) as $d
    | $e | .dependencies = (
        if ($d["@opencode-ai/plugin"] | type) == "string" then $d
        else $d + {"@opencode-ai/plugin": "1.18.31"}
        end)
  ' "$PKG" > "$PKG.tmp"
  mv "$PKG.tmp" "$PKG"
else
  printf '{\n  "dependencies": {\n    "@opencode-ai/plugin": "1.18.31"\n  }\n}\n' > "$PKG"
  mkdir -p "$PLUGIN_DIR"
fi
echo "Ensured @opencode-ai/plugin dependency in $PKG"

cat <<'EOF'

Install complete. The plugin loads at the next opencode session start
(plugins under ~/.config/opencode/plugins/ are read at startup).

To uninstall: remove ~/.config/opencode/plugins/token-optimization.ts and
optionally drop the @opencode-ai/plugin entry from
~/.config/opencode/package.json.
EOF