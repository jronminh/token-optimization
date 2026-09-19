#!/usr/bin/env bash
# Installs the opencode plugins in plugin/ into ~/.config/opencode/plugins/
# (loaded by opencode at every session start) and ensures @opencode-ai/plugin
# is declared in the config directory's package.json (opencode runs
# `bun install` there at startup).
# Idempotent: re-running overwrites each plugin with its current version and
# leaves an existing dependency entry untouched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"

command -v jq >/dev/null 2>&1 || { echo "jq is required - install it first (e.g. apt/brew/pkg install jq)" >&2; exit 1; }

mkdir -p "$PLUGIN_DIR"
for src in "$REPO_DIR"/plugin/*.ts; do
  [ -e "$src" ] || { echo "no plugins found in $REPO_DIR/plugin" >&2; exit 1; }
  cp "$src" "$PLUGIN_DIR/$(basename "$src")"
  echo "Installed $(basename "$src") -> $PLUGIN_DIR"
done

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

# --- environment.md: append the relay instruction (idempotent, marker-based) ---
# The plugins inject blocks into the model's context; this instruction tells the
# model to relay them to the user (the plugins' own TUI toasts are off). Kept in
# its own markers so re-running replaces it instead of duplicating.
ENV_FILE="$CONFIG_DIR/environment.md"
SNIPPET="$REPO_DIR/environment-snippet.md"
if [ -f "$SNIPPET" ]; then
  if [ -f "$ENV_FILE" ]; then
    stripped=$(mktemp)
    awk '
      /<!-- opencode-token-optimization:begin -->/ { skip=1; next }
      /<!-- opencode-token-optimization:end -->/   { skip=0; next }
      !skip { print }
    ' "$ENV_FILE" > "$stripped"
    { printf '%s\n\n' "$(cat "$stripped")"; cat "$SNIPPET"; } > "$ENV_FILE"
    rm -f "$stripped"
  else
    cp "$SNIPPET" "$ENV_FILE"
  fi
  echo "Installed relay instruction -> $ENV_FILE"
fi

cat <<'EOF'

Install complete. The plugins load at the next opencode session start
(plugins under ~/.config/opencode/plugins/ are read at startup).

To uninstall: remove the matching files under ~/.config/opencode/plugins/ and
optionally drop the @opencode-ai/plugin entry from
~/.config/opencode/package.json.
EOF