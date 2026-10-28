#!/usr/bin/env bash
# Link this package into $CODEX_HOME/poas so thread/start loads it.
# Default home matches the demo TUI: .home/v1-forced
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HOME_DIR="${CODEX_HOME:-$REPO/.home/v1-forced}"

mkdir -p "$HOME_DIR/poas"
ln -sfn "$HERE" "$HOME_DIR/poas/01_tui_call"
echo "installed $HERE -> $HOME_DIR/poas/01_tui_call"
