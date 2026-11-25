# AULA HUB Linux Wrapper

Native Linux (Wayland/X11 + WebHID) wrapper, auto-updater, and English cleanup patcher for the official **AULA HUB** desktop client (tested with **AULA WIN 68 HE** Hall-Effect keyboard on Arch Linux / Hyprland).

> **Note:** This repository does **not** redistribute proprietary AULA binaries (`app.asar` / `.exe`). The installer downloads the official Windows installer directly from AULA's CDN (`toolsuse.aulacn.com`) or unpacks a local `.exe`/`.zip` you provide, swaps in native Linux `sharp` binaries, and applies Linux compatibility + English patches locally.

## Features

- **Native Linux Electron Runtime**: Runs directly on system Electron (`electron41`..`electron36` / `electron`) with Wayland/Ozone hints and WebHID support.
- **Native `sharp` & Icon Handling**: Replaces `sharp-win32-x64` with `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64` and bypasses Windows `IconExtractor.exe` / PowerShell calls.
- **WIN 68 HE WebHID Fixes**: Automatically selects the vendor HID interface (`usagePage >= 0xFF00`) and sends the exit-Host-RGB-Sync packet on connect so onboard lighting controls respond properly.
- **Resilient HTTP/1.1 Auto-Updater (`linux_updater.mjs` + `apply_update.py`)**: Replaces Chromium HTTP/2 `net.fetch` (which hits `ERR_HTTP2_PROTOCOL_ERROR` on `toolsuse.aulacn.com`) with a resumable HTTP/1.1 Keep-Alive downloader (`Range: bytes=...`), SHA-512 verification, and atomic `app/` ↔ `app.bak/` swap.
- **English Cleanup (`patch_notifications_en.mjs`)**: Defaults first-run locale to English and translates remaining hardcoded Chinese dialogs, Element Plus fallbacks, tray labels, and server-returned toast errors when running in English.

## Prerequisites

- **Arch Linux**: `sudo pacman -S electron python p7zip nodejs npm curl`
- **Other distros**: `python3`, `7z` (`p7zip-full`), `nodejs`, `npm`, `curl`, and a compatible `electron` binary in `PATH` (or set `AULA_HUB_ELECTRON=/path/to/electron`).

## Quick Install

Remote one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/kan-ckm/aula-hub-linux/main/install.sh | bash
```

Or from a local clone (or using an already downloaded installer `.exe`/`.zip`):

```bash
git clone https://github.com/kan-ckm/aula-hub-linux.git
cd aula-hub-linux
./install.sh
# Or offline/custom installer:
./install.sh --installer ~/Downloads/AULA\ HUB.zip
```

Launch with `aula-hub` (from `~/.local/bin/aula-hub`) or from your desktop application menu (**AULA HUB**).

## Updating & Uninstalling

- **Update inside app**: Click **Confirm Upgrade** when prompted (uses `linux_updater.mjs` + `apply_update.py`).
- **Update via CLI**:
  ```bash
  python3 ~/.local/share/aula-hub-linux/apply_update.py --latest
  ```
- **Uninstall**:
  ```bash
  ~/.local/share/aula-hub-linux/uninstall.sh          # keep ~/.config/aula-hub
  ~/.local/share/aula-hub-linux/uninstall.sh --purge  # remove everything
  ```

## Known Limitations on Linux

- Windows-only features such as `GameSense / GSI`, `HeadsetService.exe`, `pnputil`, OS auto-start (`setLoginItemSettings`), and active-window `.exe` profile switching (`autoChangeConfig`) are safely stubbed/no-op on Linux.
- Avoid flashing keyboard firmware on Linux unless your keyboard's bootloader USB VID/PID is also covered in `/etc/udev/rules.d/99-aula-hub.rules`.
- On **WIN 68 HE**, Performance switches (*Disable Windows Key*, etc.) control which keys are blocked **when physical Win Lock (`Fn + Win`) is enabled** on the keyboard.

## Development & Release Workflow

Run the automated test suite:

```bash
./tests/run_tests.sh
```

Run tests and push updates automatically:

```bash
git config core.hooksPath .githooks   # enable pre-push test gate
./scripts/release.sh "Your commit message"
```
