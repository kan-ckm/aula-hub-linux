# aula-hub-linux

Linux wrapper, updater, and English runtime patcher for AULA HUB using system Electron and WebHID.

No proprietary AULA binaries (`app.asar`, `.exe`) are included in this repository. The installer downloads the official installer from AULA (`hubapi.aulacn.com` / `cdn.aulacn.com`, with `toolsuse.aulacn.com` fallback) or unpacks a local `.exe`/`.zip`, caches verified installers in `~/.cache/aula-hub-linux`, and patches Electron/WebHID compatibility locally via obfuscation-resilient runtime shims.

## Requirements

- `python3`
- `7z` (`p7zip` / `p7zip-full`)
- `nodejs`
- `curl`
- System `electron41` (AULA HUB v2.9.0 ships V8 bytecode compiled for Electron 41; other major versions fail with `V8 mismatch`; override via `AULA_HUB_ELECTRON`)

Arch Linux:

```bash
sudo pacman -S electron41 python p7zip nodejs curl
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

For non-root WebHID access, `install.sh` installs `udev/99-aula-hub.rules` to `/etc/udev/rules.d/99-aula-hub.rules`. Remote piped installs (`curl ... | bash`) run non-interactively and skip `sudo`; apply manually and replug your device:

```bash
sudo install -Dm644 ~/.local/share/aula-hub-linux/udev/99-aula-hub.rules /etc/udev/rules.d/99-aula-hub.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Lightweight Background GIF LED (`aula-gifd`)

Because per-key Live GIF lighting on WIN 68 HE / WIN 60 HE streams frames continuously from the host PC rather than storing them in keyboard flash, quitting the Electron UI normally resets the keyboard to its onboard lighting.

`aula-hub-linux` solves this with a zero-dependency headless Node.js daemon (`aula-gifd`, ~20 MB RAM and <0.5% CPU vs ~900 MB RAM for Electron):

- **Automatic GUI handoff**: If you quit AULA HUB while Live GIF lighting is active, `aula-gifd` automatically takes over streaming the exact frames in the background and yields cleanly whenever you reopen AULA HUB. Use **Exit & Stop GIF LED** in the tray menu to stop both.
- **Direct CLI playback** (no Electron GUI required):

```bash
aula-hub gif play /path/to/animation.gif               # smart crop + vivid LED neon grading
aula-hub gif play /path/to/animation.gif --mode crop   # strict 1:1 aspect crop, original colors
aula-hub gif play /path/to/animation.gif --mode full   # full frame fitted to keyboard ratio
aula-hub gif status                                    # show PID, RAM, FPS, and cached GIF
aula-hub gif stop                                      # stop daemon and restore onboard RGB
aula-hub gif resume                                    # resume last cached GIF
aula-hub gif autostart on                              # start cached GIF automatically on login (systemd --user)
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

- `linux_main_shim.mjs` + `dist-electron/main.mjs`: runtime Electron main-process shim (compatible with both obfuscated 1.3.9+ and legacy builds) that wraps `setLoginItemSettings`, selects vendor HID interfaces (`usagePage >= 0xFF00`), routes external `fetch()` through `electron.net.fetch`, stubs `headset-service-*` IPC handlers, translates main-process Chinese UI/notifications, injects `linux_renderer_shim.js` via `aula://`, and delegates `update:*` IPC calls to `linux_updater.mjs`.
- `dist-electron/iconWorker.mjs`: replaces `IconExtractor.exe` / PowerShell calls with direct base64 image reads on Linux (no `sharp` native build required).
- `linux_renderer_shim.js`: defaults first launch to English, sends the WIN 68 HE / WIN 60 HE Host RGB Sync exit packet on WebHID connect, and dynamically translates Chinese toast/dialog messages when running in English.
- `linux_updater.mjs`: resumable multi-stream / HTTP/1.1 Keep-Alive downloader (`Range: bytes=...`) supporting both `update:download(url, sha256)` and `latest.yml` SHA-512 flows, caching verified installers in `~/.cache/aula-hub-linux` with atomic `app/` swap via `apply_update.py`.
- `linux_gif_daemon.mjs`: zero-dependency Node.js GIF89a decoder, WIN 68 HE / WIN 60 HE LED matrix mapper, and headless `/dev/hidraw` streaming daemon (`aula-gifd`) with auto-reconnect and optional `systemd --user` autostart.
- `patch_notifications_en.mjs`: translates unobfuscated Element Plus / legacy frontend Chinese UI strings.

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
