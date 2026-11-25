# aula-hub-linux

Linux wrapper, updater, and English runtime patcher for AULA HUB using system Electron and WebHID.

No proprietary AULA binaries (`app.asar`, `.exe`) are included in this repository. The installer downloads the official installer from AULA (`toolsuse.aulacn.com`) or unpacks a local `.exe`/`.zip`, replaces Windows `sharp` with `@img/sharp-linux-x64`, and patches Electron/WebHID compatibility locally.

## Requirements

- `python3`
- `7z` (`p7zip` / `p7zip-full`)
- `nodejs` and `npm`
- `curl`
- System `electron` (`electron41`..`electron36` or `electron` in `PATH`, or set `AULA_HUB_ELECTRON`)

Arch Linux:

```bash
sudo pacman -S electron python p7zip nodejs npm curl
```

## Install

Remote:

```bash
curl -fsSL https://raw.githubusercontent.com/kan-ckm/aula-hub-linux/main/install.sh | bash
```

From a local clone or offline archive:

```bash
git clone https://github.com/kan-ckm/aula-hub-linux.git
cd aula-hub-linux
./install.sh
./install.sh --installer ~/Downloads/"AULA HUB.zip"
```

Options:
- `--prefix <dir>` — install directory (default: `~/.local/share/aula-hub-linux`)
- `--installer <path>` — install from a local `.exe` or `.zip`
- `--skip-udev` — skip installing `/etc/udev/rules.d/99-aula-hub.rules`
- `--no-download` — install wrapper scripts and `.desktop` entry only

Run with `aula-hub` (requires `~/.local/bin` in `PATH`) or via the desktop entry.

## udev Rules

For non-root WebHID access, `install.sh` installs `udev/99-aula-hub.rules` to `/etc/udev/rules.d/99-aula-hub.rules`. Manual setup:

```bash
sudo install -Dm644 udev/99-aula-hub.rules /etc/udev/rules.d/99-aula-hub.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Update & Uninstall

Update via the in-app updater or CLI:

```bash
python3 ~/.local/share/aula-hub-linux/apply_update.py --latest
```

Uninstall:

```bash
~/.local/share/aula-hub-linux/uninstall.sh
~/.local/share/aula-hub-linux/uninstall.sh --purge
```

## What Is Patched

- `dist-electron/main.mjs`: disables Windows `HeadsetService.exe`, wraps `setLoginItemSettings`, selects vendor HID interfaces (`usagePage >= 0xFF00`), uses `electron.net.fetch` for API requests, and routes `update:*` IPC calls to `linux_updater.mjs`.
- `dist-electron/iconWorker.mjs`: replaces `IconExtractor.exe` / PowerShell calls with direct base64 image reads.
- `linux_updater.mjs`: resumable HTTP/1.1 Keep-Alive downloader (`Range: bytes=...`) with SHA-512 verification and atomic `app/` swap via `apply_update.py`.
- `patch_notifications_en.mjs`: sets default locale fallback to `en` and translates remaining hardcoded Chinese UI/toast/dialog strings when running in English.

## Hardware Support

- **Hardware-verified**: AULA WIN 68 HE (`2e3c:c365`) on Arch Linux (Hyprland/Wayland).
- **Experimental (untested on hardware)**: `udev/99-aula-hub.rules` includes WebHID rules for all 79 keyboard, mouse, and wireless dongle `VID:PID` pairs listed in AULA HUB (`WIN HE`, `HERO HE`, `MINI HE`, `AG60`/`AG63`/`AG75`, `F75`/`F87`/`F108`, `V9`/`X9`, etc.).
- **Unsupported**: Headsets (`HeadsetService.exe`).

## Known Limitations

- Windows-only features are stubbed or non-functional on Linux: GameSense (`GsiManager`), `HeadsetService.exe`, `pnputil`, OS auto-start (`setLoginItemSettings`), and active-window `.exe` switching (`autoChangeConfig`).
- Do not flash keyboard firmware on Linux unless bootloader USB IDs are also permitted in udev rules.
- Tested with WIN 68 HE on Arch Linux (Hyprland/Wayland). Performance key-lock toggles (e.g., *Disable Windows Key*) apply when physical Win Lock (`Fn + Win`) is active on the keyboard.

## Development

Enable pre-push test hook and run tests:

```bash
git config core.hooksPath .githooks
./tests/run_tests.sh
```

Run tests, commit, and push:

```bash
./scripts/release.sh "Commit message"
```

## License

MIT
