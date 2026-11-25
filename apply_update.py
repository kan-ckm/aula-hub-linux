#!/usr/bin/env python3
"""Atomic, version-resilient extractor & Linux English patcher for AULA HUB updates."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
UPDATE_BASE_URL = "https://toolsuse.aulacn.com/zip-use/ClientBase/"
LATEST_YML_URL = f"{UPDATE_BASE_URL}latest.yml"


def find_node() -> str:
    for cand in (
        shutil.which("node"),
        str(Path.home() / ".local" / "bin" / "node"),
        "/usr/local/bin/node",
        "/usr/bin/node",
    ):
        if cand and Path(cand).is_file():
            return cand
    raise RuntimeError("node binary not found")


def find_npm() -> str:
    for cand in (
        shutil.which("npm"),
        str(Path.home() / ".local" / "bin" / "npm"),
        "/usr/local/bin/npm",
        "/usr/bin/npm",
    ):
        if cand and Path(cand).is_file():
            return cand
    raise RuntimeError("npm binary not found")


def parse_latest_yml(text: str) -> dict[str, str]:
    info: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip()
        v = v.strip().strip("'\"")
        if k in ("version", "path", "sha512", "size", "releaseDate"):
            info[k] = v
    return info


def fetch_latest_info() -> dict[str, str]:
    if shutil.which("curl"):
        res = subprocess.run(
            [
                "curl",
                "-4",
                "--http1.1",
                "-fsSL",
                "--retry",
                "3",
                "--retry-delay",
                "2",
                "--retry-all-errors",
                "--connect-timeout",
                "15",
                "--max-time",
                "30",
                "-A",
                "electron-updater",
                LATEST_YML_URL,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        text = res.stdout
    else:
        req = urllib.request.Request(LATEST_YML_URL, headers={"User-Agent": "electron-updater"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    info = parse_latest_yml(text)
    if not info.get("version") or not info.get("path"):
        raise RuntimeError("Invalid latest.yml response from AULA server")
    return info


def wait_for_pid_exit(pid: int, timeout_s: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            return
        time.sleep(0.2)


def unpack_asar(asar_path: Path, dest_dir: Path) -> int:
    count = 0
    with asar_path.open("rb") as f:
        f.read(12)
        json_len = struct.unpack("<I", f.read(4))[0]
        hdr = json.loads(f.read(json_len).decode("utf-8"))
        data_base = 16 + ((json_len + 3) & ~3)

        def walk(node: dict, rel: Path) -> None:
            nonlocal count
            for name, entry in node.get("files", {}).items():
                target = rel / name
                if "files" in entry:
                    target.mkdir(parents=True, exist_ok=True)
                    walk(entry, target)
                elif entry.get("unpacked"):
                    continue
                else:
                    size = int(entry.get("size", 0))
                    offset = entry.get("offset")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if offset is None or size == 0:
                        target.write_bytes(b"")
                    else:
                        f.seek(data_base + int(offset))
                        target.write_bytes(f.read(size))
                    if entry.get("executable"):
                        target.chmod(0o755)
                    count += 1

        walk(hdr, dest_dir)
    return count


def copy_tree_contents(src: Path, dst: Path) -> int:
    if not src.is_dir():
        return 0
    copied = 0
    for item in src.rglob("*"):
        rel = item.relative_to(src)
        target = dst / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            copied += 1
    return copied


def ensure_linux_sharp(app_new: Path, existing_app: Path) -> None:
    win_sharp = app_new / "node_modules" / "@img" / "sharp-win32-x64"
    if win_sharp.exists():
        shutil.rmtree(win_sharp)

    sharp_pkg_json = app_new / "node_modules" / "sharp" / "package.json"
    if not sharp_pkg_json.is_file():
        return
    meta = json.loads(sharp_pkg_json.read_text(encoding="utf-8"))
    opt = meta.get("optionalDependencies", {})
    sharp_ver = opt.get("@img/sharp-linux-x64") or meta.get("version")
    vips_ver = opt.get("@img/sharp-libvips-linux-x64")
    if not sharp_ver or not vips_ver:
        return

    dest_img_dir = app_new / "node_modules" / "@img"
    dest_img_dir.mkdir(parents=True, exist_ok=True)

    # Reuse matching local binaries if already installed in existing app/
    existing_sharp_pkg = existing_app / "node_modules" / "@img" / "sharp-linux-x64" / "package.json"
    existing_vips_pkg = existing_app / "node_modules" / "@img" / "sharp-libvips-linux-x64" / "package.json"
    if existing_sharp_pkg.is_file() and existing_vips_pkg.is_file():
        es_ver = json.loads(existing_sharp_pkg.read_text(encoding="utf-8")).get("version")
        ev_ver = json.loads(existing_vips_pkg.read_text(encoding="utf-8")).get("version")
        if es_ver == sharp_ver and ev_ver == vips_ver:
            shutil.copytree(existing_sharp_pkg.parent, dest_img_dir / "sharp-linux-x64", dirs_exist_ok=True)
            shutil.copytree(existing_vips_pkg.parent, dest_img_dir / "sharp-libvips-linux-x64", dirs_exist_ok=True)
            print(f"Reused local sharp-linux-x64@{sharp_ver} and sharp-libvips-linux-x64@{vips_ver}")
            return

    npm_bin = find_npm()
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            [
                npm_bin,
                "install",
                "--no-save",
                "--os=linux",
                "--cpu=x64",
                f"@img/sharp-linux-x64@{sharp_ver}",
                f"@img/sharp-libvips-linux-x64@{vips_ver}",
            ],
            cwd=td,
            check=True,
        )
        for pkg_name in ("sharp-linux-x64", "sharp-libvips-linux-x64"):
            src_pkg = Path(td) / "node_modules" / "@img" / pkg_name
            if not src_pkg.is_dir():
                raise RuntimeError(f"Missing fetched {pkg_name}")
            shutil.copytree(src_pkg, dest_img_dir / pkg_name, dirs_exist_ok=True)
    print(f"Installed fresh sharp-linux-x64@{sharp_ver} and sharp-libvips-linux-x64@{vips_ver}")


def patch_icon_worker(app_new: Path) -> Path:
    worker_path = app_new / "dist-electron" / "iconWorker.mjs"
    txt = worker_path.read_text(encoding="utf-8")

    # 1. Guard Windows IconExtractor spawn loop
    txt, n1 = re.subn(
        r'(function\s+\w+\s*\(\s*\)\s*\{\s*(?:var\s+\w+;\s*)?)(\w+\s*\|\|\s*\w+\s*&&\s*\(\w+\s*=\s*\w+\(\w+\))',
        r'\1if (process.platform !== "win32") return;\n  \2',
        txt,
        count=1,
    )
    if n1 != 1:
        raise RuntimeError("Failed to patch iconWorker spawn guard")

    # 2. Guard run-ps handler (looks for aula_ps_)
    txt, n2 = re.subn(
        r'(async function\s+\w+\s*\(\s*(\w+)\s*,\s*\w+\s*\)\s*\{\s*)(const\s+\w+\s*=\s*[^\n]*aula_ps_)',
        r'\1if (process.platform !== "win32") {\n    process.parentPort.postMessage({ type: "ps-result", id: \2, stdout: "", error: "PowerShell unavailable on Linux" });\n    return;\n  }\n  \3',
        txt,
        count=1,
    )
    if n2 != 1:
        raise RuntimeError("Failed to patch iconWorker run-ps guard")

    # 3. Direct base64 encoding for Linux icon files inside extract-icon handler
    m = re.search(
        r'async function\s+\w+\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{\s*try\s*\{\s*(const\s+\w+\s*=\s*await\s+\w+\(\2\);)',
        txt,
    )
    if not m:
        raise RuntimeError("Failed to locate extract-icon handler in iconWorker.mjs")
    id_var, path_var, call_stmt = m.group(1), m.group(2), m.group(3)
    # Find fs & path imports in iconWorker.mjs
    m_fs = re.search(r'import\s+(\w+)\s+from\s+"fs"', txt)
    m_path = re.search(r'import\s+(\w+)\s+from\s+"path"', txt)
    if not m_fs or not m_path:
        raise RuntimeError("Missing fs/path import in iconWorker.mjs")
    fs_var, p_var = m_fs.group(1), m_path.group(1)

    linux_icon_block = (
        f'if (process.platform !== "win32") {{\n'
        f'      if (!{path_var} || !{fs_var}.existsSync({path_var}) || !{fs_var}.statSync({path_var}).isFile()) {{\n'
        f'        process.parentPort.postMessage({{ type: "icon-result", id: {id_var}, dataUrl: "" }});\n'
        f'        return;\n'
        f'      }}\n'
        f'      const _ext = {p_var}.extname({path_var}).toLowerCase();\n'
        f'      const _mime = {{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp" }}[_ext];\n'
        f'      if (!_mime) {{\n'
        f'        process.parentPort.postMessage({{ type: "icon-result", id: {id_var}, dataUrl: "" }});\n'
        f'        return;\n'
        f'      }}\n'
        f'      const _buf = {fs_var}.readFileSync({path_var});\n'
        f'      process.parentPort.postMessage({{ type: "icon-result", id: {id_var}, dataUrl: `data:${{_mime}};base64,${{_buf.toString("base64")}}` }});\n'
        f'      return;\n'
        f'    }}\n    {call_stmt}'
    )
    txt = txt[: m.start(3)] + linux_icon_block + txt[m.end(3) :]
    worker_path.write_text(txt, encoding="utf-8")
    return worker_path


def patch_main_mjs(app_new: Path) -> Path:
    main_path = app_new / "dist-electron" / "main.mjs"
    txt = main_path.read_text(encoding="utf-8")

    # 1. Inspect electron import and add net as _lnNet + registerLinuxUpdater import
    m_imp = re.search(r'(import\s+[^;]*\{([^}]*)\}\s*from\s*"electron";)', txt)
    if not m_imp:
        raise RuntimeError("Could not find electron import in main.mjs")
    full_imp, named = m_imp.group(1), m_imp.group(2)

    m_app = re.search(r'\bapp\s+as\s+(\w+)', named)
    m_ipc = re.search(r'\bipcMain\s+as\s+(\w+)', named)
    if not m_app or not m_ipc:
        raise RuntimeError("Could not resolve app/ipcMain aliases in main.mjs")
    app_var, ipc_var = m_app.group(1), m_ipc.group(1)

    m_net = re.search(r'\bnet\s+as\s+(\w+)', named)
    if m_net:
        net_var = m_net.group(1)
        new_imp = full_imp
    elif re.search(r'\bnet\b', named):
        net_var = "net"
        new_imp = full_imp
    else:
        net_var = "_lnNet"
        new_imp = full_imp.replace("} from \"electron\";", f", net as {net_var} }} from \"electron\";")

    new_imp += '\nimport { registerLinuxUpdater as _registerLinuxUpdater } from "../../linux_updater.mjs";'
    txt = txt.replace(full_imp, new_imp, 1)

    # 2. Guard HeadsetService.exe launcher on non-win32
    txt, n_hs = re.subn(
        r'(function\s+\w+\s*\(\s*\)\s*\{\s*(?:var\s+[^;]+;\s*)?)(if\s*\([^)]+\)\s*return\s+console\.log\("\[headsetManager\])',
        r'\1if (process.platform !== "win32")\n    return !1;\n  \2',
        txt,
        count=1,
    )
    if n_hs != 1:
        raise RuntimeError("Failed to patch HeadsetService guard in main.mjs")

    # 3. Wrap app.setLoginItemSettings(...) safely
    login_pat = re.compile(rf'{re.escape(app_var)}\.setLoginItemSettings\(\{{[\s\S]{{0,180}}?\n\s*\}}\)')
    txt, n_login = login_pat.subn(
        lambda m: f'(() => {{ try {{ {m.group(0)}; }} catch {{}} }})()',
        txt,
    )
    if n_login < 1:
        raise RuntimeError("Failed to wrap setLoginItemSettings in main.mjs")

    # 4. Add select-hid-device handler right after setDevicePermissionHandler(...)
    m_dev = re.search(
        r'((\w+)\.webContents\.session\.setDevicePermissionHandler\([\s\S]{0,240}?aula://"\)\))(?=[,;])',
        txt,
    )
    if not m_dev:
        raise RuntimeError("Failed to locate setDevicePermissionHandler in main.mjs")
    dev_call, win_var = m_dev.group(1), m_dev.group(2)
    hid_hook = (
        f'{dev_call}, {win_var}.webContents.session.listenerCount("select-hid-device") || '
        f'{win_var}.webContents.session.on("select-hid-device", (_ev, _det, _cb) => {{\n'
        f'  _ev.preventDefault();\n'
        f'  const _list = _det.deviceList || [];\n'
        f'  const _pref = _list.find((_item) => Array.isArray(_item.collections) && _item.collections.some((_c) => _c.usagePage >= 65280)) || _list[0];\n'
        f'  _cb(_pref ? _pref.deviceId : "");\n'
        f'}})'
    )
    txt = txt[: m_dev.start(1)] + hid_hook + txt[m_dev.end(1) :]

    # 5. Harden http-bridge retry + Electron net.fetch with 30s min timeout
    m_retry = re.search(
        r'const\s+([$\w]+)\s*=\s*\([$\w]+\s*=\s*([$\w]+)\s*==\s*null\s*\?\s*void\s*0\s*:\s*\2\.cause\)\s*==\s*null\s*\?\s*void\s*0\s*:\s*[$\w]+\.code;\s*'
        r'if\s*\(!([$\w]+)\.includes\(\1\)\s*\|\|\s*([$\w]+)\s*===\s*([$\w]+)\s*-\s*1\)\s*throw\s+\2;',
        txt,
    )
    if not m_retry:
        raise RuntimeError("Failed to locate http-bridge retry guard in main.mjs")
    code_var, err_var, list_var, idx_var, max_var = (
        m_retry.group(1),
        m_retry.group(2),
        m_retry.group(3),
        m_retry.group(4),
        m_retry.group(5),
    )
    retry_repl = (
        f'{m_retry.group(0).split("if")[0]}'
        f'const _isTimeout = String(({err_var} == null ? void 0 : {err_var}.message) || "").includes("timeout");\n'
        f'          if ((!{list_var}.includes({code_var}) && !_isTimeout) || {idx_var} === {max_var} - 1)\n'
        f'            throw {err_var};'
    )
    txt = txt[: m_retry.start()] + retry_repl + txt[m_retry.end() :]

    m_fetch = re.search(
        r'async function\s+([$\w]+)\s*\(\s*([$\w]+)\s*,\s*([$\w]+)\s*,\s*([$\w]+)\s*\)\s*\{\s*'
        r'const\s+[$\w]+\s*=\s*new AbortController\(\);\s*'
        r'let\s+[$\w]+\s*=\s*!1,\s*[$\w]+;\s*'
        r'[\s\S]{0,250}?return await fetch\([^)]+\);\s*\}\s*catch[\s\S]{0,160}?\}\s*\}',
        txt,
    )
    if not m_fetch:
        raise RuntimeError("Failed to locate fetch wrapper sg() in main.mjs")
    fn_name, url_arg, opt_arg, to_arg = m_fetch.group(1), m_fetch.group(2), m_fetch.group(3), m_fetch.group(4)
    new_fetch_fn = (
        f'async function {fn_name}({url_arg}, {opt_arg}, {to_arg}) {{\n'
        f'  const _to = {to_arg} && {to_arg} > 0 ? Math.max({to_arg}, 30000) : 30000;\n'
        f'  const _ac = new AbortController();\n'
        f'  let _aborted = !1;\n'
        f'  const _timer = setTimeout(() => {{ _aborted = !0; _ac.abort(); }}, _to);\n'
        f'  try {{\n'
        f'    const _fn = {net_var} && typeof {net_var}.fetch === "function" ? {net_var}.fetch.bind({net_var}) : fetch;\n'
        f'    return await _fn({url_arg}.toString(), {{ ...{opt_arg}, signal: _ac.signal }});\n'
        f'  }} catch (_err) {{\n'
        f'    throw _aborted ? new Error(`timeout of ${{_to}}ms exceeded`) : _err;\n'
        f'  }} finally {{\n'
        f'    clearTimeout(_timer);\n'
        f'  }}\n'
        f'}}'
    )
    txt = txt[: m_fetch.start()] + new_fetch_fn + txt[m_fetch.end() :]

    # 6. Hook autoUpdater setup function Wm(getWin) -> delegate to linux_updater.mjs on Linux
    m_upd = re.search(
        r'(function\s+[$\w]+\s*\(\s*([$\w]+)\s*\)\s*\{)([\s\S]{0,800}?autoUpdater\.logger\s*=\s*\{\s*info:\s*\([$\w]+\)\s*=>\s*([$\w]+)\([\s\S]{0,4000}?([$\w]+)\(\)\s*,\s*[$\w]+\.autoUpdater\.quitAndInstall\(\);)',
        txt,
    )
    if not m_upd:
        raise RuntimeError("Failed to locate autoUpdater setup function in main.mjs")
    fn_head, get_win_arg, log_fn, quit_fn = m_upd.group(1), m_upd.group(2), m_upd.group(4), m_upd.group(5)
    linux_upd_hook = (
        f'{fn_head}\n'
        f'  if (process.platform === "linux") {{\n'
        f'    _registerLinuxUpdater({{ app: {app_var}, ipcMain: {ipc_var}, net: {net_var}, getMainWindow: {get_win_arg}, log: {log_fn}, onBeforeQuitForUpdate: {quit_fn} }});\n'
        f'    return;\n'
        f'  }}'
    )
    txt = txt[: m_upd.start(1)] + linux_upd_hook + txt[m_upd.end(1) :]

    main_path.write_text(txt, encoding="utf-8")
    return main_path


def patch_frontend_assets(app_new: Path, target_root: Path) -> list[Path]:
    assets_dir = app_new / "dist" / "assets"
    touched: list[Path] = []

    # 1. WIN 68 HE (rlw) Host RGB Sync exit packet on connect
    rlw_patched = 0
    for p in sorted(assets_dir.glob("info-*.js")):
        s = p.read_text(encoding="utf-8", errors="ignore")
        if "usagePage===e.usagePage&&r.usage===e.usage" in s:
            if "s&&!s.opened&&await s.open();" not in s:
                raise RuntimeError(f"Expected open sequence missing in {p.name}")
            s = s.replace(
                "s&&!s.opened&&await s.open();",
                "s&&!s.opened&&await s.open();if(s&&s.opened){try{const _syncOff=new Uint8Array(63);_syncOff[0]=23,_syncOff[4]=2,await s.sendReport(1,_syncOff)}catch{}}",
                1,
            )
            p.write_text(s, encoding="utf-8")
            touched.append(p)
            rlw_patched += 1
    if rlw_patched == 0:
        raise RuntimeError("Could not find info-*.js with WIN 68 HE usagePage/usage matcher")

    # Default fallback -> "en" in index-*.js when no saved preference exists
    idx_patched = 0
    for p in sorted(assets_dir.glob("index-*.js")):
        s = p.read_text(encoding="utf-8", errors="ignore")
        if "createI18n" not in s:
            continue

        # Default fallback -> "en" when no saved preference exists
        s = re.sub(
            r'if\(!\w+\)return"zh";const (\w+)=JSON\.parse\(\w+\);return\(\1==null\?void 0:\1\.language\)\|\|"zh"\}catch\{return"zh"\}',
            lambda m: m.group(0).replace('"zh"', '"en"'),
            s,
            count=1,
        )
        s = re.sub(
            r'createI18n\(\{legacy:!1,locale:"zh",fallbackLocale:"zh"',
            'createI18n({legacy:!1,locale:"en",fallbackLocale:"en"',
            s,
            count=1,
        )
        s = s.replace(',language:"zh",ACC_Config:', ',language:"en",ACC_Config:', 1)
        p.write_text(s, encoding="utf-8")
        touched.append(p)
        idx_patched += 1
    if idx_patched == 0:
        raise RuntimeError("Could not find index-*.js with createI18n")

    return touched


def extract_and_build(source: Path, target_root: Path) -> None:
    target_root.mkdir(parents=True, exist_ok=True)
    app_dir = target_root / "app"
    app_new = target_root / "app.new"
    app_bak = target_root / "app.bak"

    if app_new.exists():
        shutil.rmtree(app_new)
    app_new.mkdir(parents=True, exist_ok=True)

    # Ensure support scripts exist in target_root if testing an alternate directory
    if target_root.resolve() != ROOT_DIR.resolve():
        for fname in ("linux_updater.mjs", "patch_notifications_en.mjs"):
            src_f = ROOT_DIR / fname
            if src_f.is_file():
                shutil.copy2(src_f, target_root / fname)

    with tempfile.TemporaryDirectory() as td_str:
        td = Path(td_str)
        if source.suffix.lower() == ".zip":
            setup_exe = td / "setup.exe"
            with zipfile.ZipFile(source) as zf:
                exe_members = [n for n in zf.namelist() if n.lower().endswith(".exe")]
                if not exe_members:
                    raise RuntimeError(f"No .exe found inside {source}")
                with zf.open(exe_members[0]) as src_f, setup_exe.open("wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f, length=1024 * 1024)
        else:
            setup_exe = source

        subprocess.run(
            ["7z", "e", "-y", f"-o{td}", str(setup_exe), "$PLUGINSDIR/app-64.7z"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        app7z = td / "app-64.7z"
        extract_root = td / "extracted"
        extract_root.mkdir()
        subprocess.run(
            [
                "7z",
                "x",
                "-y",
                f"-o{extract_root}",
                str(app7z),
                "resources/app.asar",
                "resources/app.asar.unpacked",
                "resources/build-icons",
                "resources/overlay-presets",
            ],
            check=False,
            stdout=subprocess.DEVNULL,
        )

        resources_dir = extract_root / "resources"
        asar_file = resources_dir / "app.asar"
        if not asar_file.is_file():
            raise RuntimeError("Failed to extract resources/app.asar")

        asar_cnt = unpack_asar(asar_file, app_new)
        unpacked_cnt = copy_tree_contents(resources_dir / "app.asar.unpacked", app_new)
        copy_tree_contents(resources_dir / "build-icons", app_new / "electron" / "build-icons")
        copy_tree_contents(resources_dir / "overlay-presets", app_new / "src" / "assets" / "jpg")

        public_ico = app_new / "public" / "app-ico.png"
        public_ico.parent.mkdir(parents=True, exist_ok=True)
        dist_ico = app_new / "dist" / "app-ico.png"
        fallback_ico = app_new / "electron" / "build-icons" / "logo.png"
        if dist_ico.is_file():
            shutil.copy2(dist_ico, public_ico)
        elif fallback_ico.is_file():
            shutil.copy2(fallback_ico, public_ico)

    print(f"Unpacked app.asar ({asar_cnt} files) + unpacked ({unpacked_cnt} files)")
    ensure_linux_sharp(app_new, app_dir)

    patched_files: list[Path] = [
        patch_icon_worker(app_new),
        patch_main_mjs(app_new),
        *patch_frontend_assets(app_new, target_root),
    ]

    patch_notif_script = target_root / "patch_notifications_en.mjs"
    if not patch_notif_script.is_file():
        patch_notif_script = ROOT_DIR / "patch_notifications_en.mjs"
    if patch_notif_script.is_file():
        node_bin_notif = find_node()
        subprocess.run([node_bin_notif, str(patch_notif_script), str(app_new)], check=True)
        for cand in (
            app_new / "dist-electron" / "main.mjs",
            *sorted((app_new / "dist" / "assets").glob("*.js")),
        ):
            if cand.is_file() and cand not in patched_files and any(
                cand.name.startswith(pref)
                for pref in ("main.", "index-", "element-plus-", "key-", "softwarePicker-", "info-")
            ):
                patched_files.append(cand)

    node_bin = find_node()
    for pf in patched_files:
        subprocess.run([node_bin, "--check", str(pf)], check=True)
    print(f"Syntax check OK on {len(patched_files)} patched files")

    # Atomic swap with rollback
    if app_bak.exists():
        shutil.rmtree(app_bak)
    try:
        if app_dir.exists():
            app_dir.rename(app_bak)
        app_new.rename(app_dir)
    except Exception:
        if not app_dir.exists() and app_bak.exists():
            app_bak.rename(app_dir)
        raise

    print(f"Updated {app_dir} successfully (previous version backed up in {app_bak})")


def download_and_verify_latest(dest_dir: Path) -> tuple[dict[str, str], Path]:
    info = fetch_latest_info()
    url = urllib.parse.urljoin(UPDATE_BASE_URL, urllib.parse.quote(info["path"]))
    safe_ver = re.sub(r"[^a-zA-Z0-9._-]", "_", info["version"])
    dest = dest_dir / f"aula-hub-update-{safe_ver}.exe"
    print(f"Downloading {info['version']} from {url} ...")
    if shutil.which("curl"):
        subprocess.run(
            [
                "curl",
                "-4",
                "--http1.1",
                "-fL",
                "-C",
                "-",
                "--retry",
                "5",
                "--retry-delay",
                "2",
                "--retry-all-errors",
                "--speed-limit",
                "1024",
                "--speed-time",
                "30",
                "--connect-timeout",
                "15",
                "-A",
                "electron-updater",
                "-o",
                str(dest),
                url,
            ],
            check=True,
        )
        h = hashlib.sha512()
        with dest.open("rb") as f:
            while chunk := f.read(256 * 1024):
                h.update(chunk)
    else:
        req = urllib.request.Request(url, headers={"User-Agent": "electron-updater"})
        h = hashlib.sha512()
        with urllib.request.urlopen(req, timeout=120) as resp, dest.open("wb") as out:
            while chunk := resp.read(256 * 1024):
                h.update(chunk)
                out.write(chunk)
    digest = base64.b64encode(h.digest()).decode("ascii")
    if info.get("sha512") and digest != info["sha512"]:
        dest.unlink(missing_ok=True)
        raise RuntimeError("SHA-512 mismatch on downloaded installer")
    print(f"Downloaded and verified {dest} (sha512 OK)")
    return info, dest


def main() -> int:
    parser = argparse.ArgumentParser(description="Native Linux updater/patcher for AULA HUB")
    parser.add_argument("source", nargs="?", help="Path to Aula Hub Setup .exe or .zip")
    parser.add_argument("--check", action="store_true", help="Check current vs latest version")
    parser.add_argument("--latest", action="store_true", help="Download latest installer and apply")
    parser.add_argument("--wait-pid", type=int, default=0, help="Wait for running PID to exit before swap")
    parser.add_argument("--relaunch", action="store_true", help="Relaunch aula-hub after update")
    parser.add_argument("--target-dir", default=str(ROOT_DIR), help="Target directory containing app/")
    args = parser.parse_args()

    target_root = Path(args.target_dir).resolve()

    if args.check:
        pkg = target_root / "app" / "package.json"
        cur_ver = json.loads(pkg.read_text(encoding="utf-8")).get("version", "unknown") if pkg.is_file() else "none"
        info = fetch_latest_info()
        print(f"Current version: {cur_ver}")
        print(f"Latest version:  {info.get('version')} ({info.get('path')}, size={info.get('size')})")
        return 0

    if args.wait_pid > 0:
        wait_for_pid_exit(args.wait_pid)

    cleanup_path: Path | None = None
    if args.latest:
        _, src_path = download_and_verify_latest(Path("/tmp"))
        cleanup_path = src_path
    elif args.source:
        src_path = Path(args.source).resolve()
        if not src_path.is_file():
            raise FileNotFoundError(f"Installer not found: {src_path}")
        if src_path.parent == Path("/tmp") and src_path.name.startswith("aula-hub-update-"):
            cleanup_path = src_path
    else:
        parser.error("Provide an installer path, --check, or --latest")

    try:
        extract_and_build(src_path, target_root)
    finally:
        if cleanup_path and cleanup_path.exists():
            cleanup_path.unlink(missing_ok=True)

    if args.relaunch:
        launcher = target_root / "aula-hub"
        if launcher.is_file():
            subprocess.Popen(
                [str(launcher)],
                cwd=str(target_root),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            print(f"Relaunched {launcher}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
