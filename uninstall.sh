#!/usr/bin/env bash
set -euo pipefail

PREFIX=""
PURGE=0

usage() {
  cat <<'EOF'
Uninstall AULA HUB Native Linux Wrapper

Usage:
  uninstall.sh [options]

Options:
  --prefix <dir>   Install directory to remove (default: ${XDG_DATA_HOME:-~/.local/share}/aula-hub-linux)
  --purge          Also remove user settings and logs in ~/.config/aula-hub
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?Missing argument for --prefix}"
      shift 2
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

INSTALL_DIR="${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/aula-hub-linux}"
BIN_LINK="$HOME/.local/bin/aula-hub"
DESKTOP_FILE="$HOME/.local/share/applications/aula-hub.desktop"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aula-hub"

if [[ -f "$INSTALL_DIR/linux_gif_daemon.mjs" ]] && command -v node >/dev/null 2>&1; then
  node "$INSTALL_DIR/linux_gif_daemon.mjs" stop >/dev/null 2>&1 || true
  node "$INSTALL_DIR/linux_gif_daemon.mjs" autostart off >/dev/null 2>&1 || true
fi

if [[ -L "$BIN_LINK" || -f "$BIN_LINK" ]]; then
  rm -f "$BIN_LINK"
  echo "Removed $BIN_LINK"
fi

if [[ -f "$DESKTOP_FILE" ]]; then
  rm -f "$DESKTOP_FILE"
  echo "Removed $DESKTOP_FILE"
fi

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  echo "Removed $INSTALL_DIR"
fi

if [[ "$PURGE" -eq 1 && -d "$CONFIG_DIR" ]]; then
  rm -rf "$CONFIG_DIR"
  echo "Purged $CONFIG_DIR"
fi

if [[ -f /etc/udev/rules.d/99-aula-hub.rules ]]; then
  echo "Note: /etc/udev/rules.d/99-aula-hub.rules is still present."
  echo "Remove it manually if desired: sudo rm -f /etc/udev/rules.d/99-aula-hub.rules && sudo udevadm control --reload-rules"
fi

echo "AULA HUB wrapper uninstalled."
