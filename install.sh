#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="kan-ckm/aula-hub-linux"
BRANCH_DEFAULT="main"

PREFIX=""
INSTALLER_PATH=""
SKIP_UDEV=0
NO_DOWNLOAD=0
REPO="$REPO_DEFAULT"
BRANCH="$BRANCH_DEFAULT"

usage() {
  cat <<'EOF'
Install AULA HUB Native Linux Wrapper

Usage:
  install.sh [options]

Options:
  --prefix <dir>       Install directory (default: ${XDG_DATA_HOME:-~/.local/share}/aula-hub-linux)
  --installer <path>   Use an existing local Aula Hub Setup .exe or .zip instead of downloading
  --skip-udev          Do not install /etc/udev/rules.d/99-aula-hub.rules
  --no-download        Only install wrapper scripts & desktop entry without downloading AULA HUB
  --repo <owner/repo>  GitHub repo for standalone remote install (default: kan-ckm/aula-hub-linux)
  --branch <branch>    Git branch for standalone remote install (default: main)
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?Missing argument for --prefix}"
      shift 2
      ;;
    --installer)
      INSTALLER_PATH="${2:?Missing argument for --installer}"
      shift 2
      ;;
    --skip-udev)
      SKIP_UDEV=1
      shift
      ;;
    --no-download)
      NO_DOWNLOAD=1
      shift
      ;;
    --repo)
      REPO="${2:?Missing argument for --repo}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?Missing argument for --branch}"
      shift 2
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

find_electron() {
  if [[ -n "${AULA_HUB_ELECTRON:-}" ]] && command -v "$AULA_HUB_ELECTRON" >/dev/null 2>&1; then
    return 0
  fi
  local c
  for c in electron41 electron40 electron39 electron38 electron37 electron36 electron; do
    if command -v "$c" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

check_deps() {
  local missing=()
  local cmd
  for cmd in python3 7z node curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required tools: ${missing[*]}" >&2
    echo "Install hints:" >&2
    echo "  Arch Linux:   sudo pacman -S python p7zip nodejs curl electron41" >&2
    echo "  Debian/Ubuntu: sudo apt install python3 p7zip-full nodejs curl" >&2
    echo "  Fedora:       sudo dnf install python3 p7zip p7zip-plugins nodejs curl" >&2
    exit 1
  fi

  if ! find_electron; then
    if [[ "$NO_DOWNLOAD" -eq 1 ]]; then
      echo "Warning: Electron binary not found; install Electron before running aula-hub." >&2
    else
      echo "Missing required Electron runtime (tried electron41..electron36, electron)." >&2
      echo "Install system Electron 41 (e.g. 'sudo pacman -S electron41' on Arch) or set AULA_HUB_ELECTRON." >&2
      exit 1
    fi
  fi
}

check_deps

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SOURCE_DIR=""
TMP_FETCH=""

cleanup() {
  if [[ -n "$TMP_FETCH" && -d "$TMP_FETCH" ]]; then
    rm -rf "$TMP_FETCH"
  fi
}
trap cleanup EXIT

if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  CANDIDATE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [[ -f "$CANDIDATE_DIR/apply_update.py" && -f "$CANDIDATE_DIR/linux_updater.mjs" ]]; then
    SOURCE_DIR="$CANDIDATE_DIR"
  fi
fi

if [[ -z "$SOURCE_DIR" ]]; then
  TMP_FETCH="$(mktemp -d)"
  TAR_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
  echo "Fetching wrapper scripts from ${TAR_URL} ..."
  curl -fsSL "$TAR_URL" | tar -xz -C "$TMP_FETCH"
  SOURCE_DIR="$(find "$TMP_FETCH" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$SOURCE_DIR" || ! -f "$SOURCE_DIR/apply_update.py" ]]; then
    echo "Error: Failed to unpack wrapper source from GitHub." >&2
    exit 1
  fi
fi

echo "Installing AULA HUB wrapper to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/udev"

for f in aula-hub apply_update.py linux_updater.mjs linux_main_shim.mjs linux_renderer_shim.js patch_notifications_en.mjs uninstall.sh; do
  if [[ -f "$SOURCE_DIR/$f" ]]; then
    cp -f "$SOURCE_DIR/$f" "$INSTALL_DIR/$f"
  fi
done
if [[ -f "$SOURCE_DIR/udev/99-aula-hub.rules" ]]; then
  cp -f "$SOURCE_DIR/udev/99-aula-hub.rules" "$INSTALL_DIR/udev/99-aula-hub.rules"
fi

chmod +x "$INSTALL_DIR/aula-hub" "$INSTALL_DIR/apply_update.py" "$INSTALL_DIR/uninstall.sh"

if [[ "$NO_DOWNLOAD" -eq 0 ]]; then
  if [[ -n "$INSTALLER_PATH" ]]; then
    python3 "$INSTALL_DIR/apply_update.py" "$INSTALLER_PATH" --target-dir "$INSTALL_DIR"
  else
    python3 "$INSTALL_DIR/apply_update.py" --latest --target-dir "$INSTALL_DIR"
  fi
fi

BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APPS_DIR"

ln -sf "$INSTALL_DIR/aula-hub" "$BIN_DIR/aula-hub"

PKG_VER=""
if [[ -f "$INSTALL_DIR/app/package.json" ]]; then
  PKG_VER="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||"")}catch{}' "$INSTALL_DIR/app/package.json")"
fi
DESKTOP_COMMENT="Native Linux wrapper for AULA HUB"
if [[ -n "$PKG_VER" ]]; then
  DESKTOP_COMMENT="Native Linux wrapper for AULA HUB (v${PKG_VER})"
fi

cat > "$APPS_DIR/aula-hub.desktop" <<EOF
[Desktop Entry]
Name=AULA HUB
Comment=${DESKTOP_COMMENT}
Exec=${INSTALL_DIR}/aula-hub
Icon=${INSTALL_DIR}/app/electron/build-icons/logo.png
Type=Application
Terminal=false
Categories=Utility;
StartupWMClass=aula-hub
EOF

if [[ "$SKIP_UDEV" -eq 0 && -f "$INSTALL_DIR/udev/99-aula-hub.rules" ]]; then
  UDEV_DEST="/etc/udev/rules.d/99-aula-hub.rules"
  if [[ "$(id -u)" -eq 0 ]]; then
    install -Dm644 "$INSTALL_DIR/udev/99-aula-hub.rules" "$UDEV_DEST"
    udevadm control --reload-rules && udevadm trigger || true
  elif sudo -n true 2>/dev/null || [[ -t 0 ]]; then
    echo "Installing udev rules to $UDEV_DEST (may ask for sudo password)..."
    if sudo install -Dm644 "$INSTALL_DIR/udev/99-aula-hub.rules" "$UDEV_DEST"; then
      sudo udevadm control --reload-rules && sudo udevadm trigger || true
    else
      echo "Skipped udev rule install. To enable keyboard HID access later, run:"
      echo "  sudo install -Dm644 \"$INSTALL_DIR/udev/99-aula-hub.rules\" \"$UDEV_DEST\" && sudo udevadm control --reload-rules && sudo udevadm trigger"
    fi
  else
    echo "Non-interactive shell: skipping sudo udev rule install. Run manually:"
    echo "  sudo install -Dm644 \"$INSTALL_DIR/udev/99-aula-hub.rules\" \"$UDEV_DEST\" && sudo udevadm control --reload-rules && sudo udevadm trigger"
  fi
fi

echo ""
echo "Installation complete!"
echo "  Launcher: $BIN_DIR/aula-hub (ensure ~/.local/bin is in PATH)"
echo "  Desktop:  $APPS_DIR/aula-hub.desktop"
echo "  App dir:  $INSTALL_DIR"
