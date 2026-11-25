#!/usr/bin/env python3
"""Atomic, version-resilient extractor & Linux English patcher for AULA HUB updates."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
HUB_API_BASE = os.environ.get("AULA_HUB_API_BASE", "https://hubapi.aulacn.com").rstrip("/")
NEW_VERSION_API_URL = os.environ.get(
    "AULA_UPDATE_API_URL", f"{HUB_API_BASE}/user/Client/getNewVersion"
)
UPDATE_BASE_URL = (
    os.environ.get(
        "AULA_UPDATE_BASE_URL", "https://toolsuse.aulacn.com/zip-use/ClientBase/"
    ).rstrip("/")
    + "/"
)
LATEST_YML_URL = f"{UPDATE_BASE_URL}latest.yml"
DEFAULT_PARALLEL_WORKERS = max(
    1, min(12, int(os.environ.get("AULA_DOWNLOAD_WORKERS", "6") or "6"))
)
DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024
SINGLE_STREAM_ONLY_HOSTS = {"toolsuse.aulacn.com"}


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


def normalize_download_url(raw_url: str, base_url: str = "") -> str:
    url = raw_url.strip()
    if not re.match(r"^https?://", url, re.IGNORECASE):
        if base_url:
            url = urllib.parse.urljoin(base_url, url.lstrip("/"))
        else:
            url = f"{HUB_API_BASE}/files/{url.lstrip('/')}"
    parsed = urllib.parse.urlsplit(url)
    quoted_path = urllib.parse.quote(parsed.path, safe="/%")
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, quoted_path, parsed.query, parsed.fragment)
    )


def parse_hub_version_json(text: str) -> dict[str, str]:
    payload = json.loads(text)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        data = payload if isinstance(payload, dict) else {}
    version = str(data.get("version") or "").strip()
    raw_url = str(data.get("url") or "").strip()
    if not version or not raw_url:
        raise RuntimeError("Invalid getNewVersion response from AULA API")
    url = normalize_download_url(raw_url)
    info: dict[str, str] = {
        "version": version,
        "url": url,
        "path": urllib.parse.unquote(Path(urllib.parse.urlsplit(url).path).name),
        "source": "hubapi",
    }
    if data.get("sha256"):
        info["sha256"] = str(data["sha256"]).strip().lower()
    if data.get("size"):
        info["size"] = str(data["size"]).strip()
    if data.get("hotUpdateUrl"):
        info["hotUpdateUrl"] = normalize_download_url(str(data["hotUpdateUrl"]))
    if data.get("hotUpdateSha256"):
        info["hotUpdateSha256"] = str(data["hotUpdateSha256"]).strip().lower()
    return info


def _fetch_text(url: str, timeout_s: int = 20) -> str:
    if shutil.which("curl"):
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                res = subprocess.run(
                    [
                        "curl",
                        "-4",
                        "--http1.1",
                        "-fsSL",
                        "--connect-timeout",
                        "10",
                        "--max-time",
                        str(timeout_s),
                        "-A",
                        "electron-updater",
                        url,
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                return res.stdout
            except subprocess.CalledProcessError as exc:
                last_err = exc
                if attempt < 3:
                    time.sleep(0.5 * (attempt + 1))
        assert last_err is not None
        raise last_err
    req = urllib.request.Request(url, headers={"User-Agent": "electron-updater"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_latest_info() -> dict[str, str]:
    use_legacy_only = bool(
        os.environ.get("AULA_UPDATE_BASE_URL")
        and not os.environ.get("AULA_UPDATE_API_URL")
        and not os.environ.get("AULA_HUB_API_BASE")
    )
    if not use_legacy_only:
        try:
            text = _fetch_text(NEW_VERSION_API_URL, timeout_s=20)
            return parse_hub_version_json(text)
        except Exception as exc:
            print(
                f"Note: primary AULA API unavailable ({exc}); falling back to legacy latest.yml",
                file=sys.stderr,
            )

    text = _fetch_text(LATEST_YML_URL, timeout_s=30)
    info = parse_latest_yml(text)
    if not info.get("version") or not info.get("path"):
        raise RuntimeError("Invalid latest.yml response from AULA server")
    info["url"] = urllib.parse.urljoin(UPDATE_BASE_URL, urllib.parse.quote(info["path"]))
    info["source"] = "legacy"
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


def ensure_linux_sharp(
    app_new: Path, existing_app: Path, install_sharp: bool = False
) -> None:
    win_sharp = app_new / "node_modules" / "@img" / "sharp-win32-x64"
    if win_sharp.exists():
        shutil.rmtree(win_sharp)

    if not install_sharp and os.environ.get("AULA_INSTALL_SHARP", "") != "1":
        # Linux iconWorker reads image files directly without sharp; skip npm install to speed up setup.
        return

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


LINUX_ICON_WORKER_SHIM = '''import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  await import("./iconWorker.orig.mjs");
} else {
  const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
  };

  setImmediate(() => {
    process.parentPort?.postMessage({ type: "worker-ready" });
  });

  process.parentPort?.on("message", ({ data }) => {
    if (!data || typeof data !== "object") return;
    const { type, id } = data;
    if (type === "run-ps") {
      process.parentPort?.postMessage({
        type: "ps-result",
        id,
        stdout: "",
        error: "PowerShell unavailable on Linux",
      });
      return;
    }
    if (type === "extract-icon") {
      try {
        const filePath = data.filePath;
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          process.parentPort?.postMessage({ type: "icon-result", id, dataUrl: "" });
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_BY_EXT[ext];
        if (!mime) {
          process.parentPort?.postMessage({ type: "icon-result", id, dataUrl: "" });
          return;
        }
        const buf = fs.readFileSync(filePath);
        process.parentPort?.postMessage({
          type: "icon-result",
          id,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        });
      } catch {
        process.parentPort?.postMessage({ type: "icon-result", id, dataUrl: "" });
      }
    }
  });
}
'''

LINUX_MAIN_WRAPPER = '''import { installLinuxMainShim } from "../../linux_main_shim.mjs";
await installLinuxMainShim();
await import("./main.orig.mjs");
'''

LINUX_MAIN_CJS_WRAPPER = """'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const shimUrl = pathToFileURL(path.resolve(__dirname, '../../linux_main_shim.mjs')).href;
  const { installLinuxMainShim } = await import(shimUrl);
  await installLinuxMainShim();
  require('./main.orig.cjs');
})().catch((err) => {
  console.error('[aula-hub-linux] Fatal startup error:', err);
  process.exit(1);
});
"""


def patch_icon_worker(app_new: Path) -> Path:
    worker_path = app_new / "dist-electron" / "iconWorker.mjs"
    if not worker_path.is_file():
        raise RuntimeError(f"Missing {worker_path}")
    orig_path = app_new / "dist-electron" / "iconWorker.orig.mjs"
    if not orig_path.exists():
        worker_path.rename(orig_path)
    worker_path.write_text(LINUX_ICON_WORKER_SHIM, encoding="utf-8")
    return worker_path


def patch_bytecode_loader(app_new: Path) -> Path | None:
    loader_path = app_new / "dist-electron" / "bytecode-loader.cjs"
    if not loader_path.is_file():
        return None
    txt = loader_path.read_text(encoding="utf-8")
    if "FLAG_HASH_OFFSET + 8" in txt:
        return loader_path

    pat = re.compile(
        r"Buffer\.from\((dummyBytecode)\)\.copy\(\s*(bytecodeBuffer)\s*,\s*(FLAG_HASH_OFFSET)\s*,\s*\3\s*,\s*\3\s*\+\s*4\s*\)"
    )

    def repl(m: re.Match[str]) -> str:
        dummy_var, buf_var, off_var = m.group(1), m.group(2), m.group(3)
        return (
            f'if ({buf_var}.readUInt32LE(4) !== {dummy_var}.readUInt32LE(4)) {{\n'
            f'    throw new Error(`[bytecode] V8 mismatch: expected hash 0x${{{buf_var}.readUInt32LE(4).toString(16)}}, got 0x${{{dummy_var}.readUInt32LE(4).toString(16)}} (Electron ${{process.versions.electron || "unknown"}}; install electron41)`);\n'
            f'  }}\n'
            f'  Buffer.from({dummy_var}).copy({buf_var}, {off_var}, {off_var}, {off_var} + 8)'
        )

    new_txt, n = pat.subn(repl, txt, count=1)
    if n != 1:
        raise RuntimeError(f"Failed to patch V8 header copy in {loader_path}")
    loader_path.write_text(new_txt, encoding="utf-8")
    return loader_path


def patch_main_mjs(app_new: Path) -> list[Path]:
    dist_electron = app_new / "dist-electron"
    main_cjs = dist_electron / "main.cjs"
    main_mjs = dist_electron / "main.mjs"

    if main_cjs.is_file():
        orig_cjs = dist_electron / "main.orig.cjs"
        if not orig_cjs.exists():
            main_cjs.rename(orig_cjs)
        main_cjs.write_text(LINUX_MAIN_CJS_WRAPPER, encoding="utf-8")
        out: list[Path] = [main_cjs]
        loader_path = patch_bytecode_loader(app_new)
        if loader_path is not None:
            out.append(loader_path)
        return out

    if main_mjs.is_file():
        orig_mjs = dist_electron / "main.orig.mjs"
        if not orig_mjs.exists():
            main_mjs.rename(orig_mjs)
        main_mjs.write_text(LINUX_MAIN_WRAPPER, encoding="utf-8")
        return [main_mjs]

    raise RuntimeError(f"Missing {main_mjs} or {main_cjs}")


def patch_frontend_assets(app_new: Path, target_root: Path) -> list[Path]:
    assets_dir = app_new / "dist" / "assets"
    dist_dir = app_new / "dist"
    touched: list[Path] = []

    # 1. Install runtime renderer shim into dist/ and inject into dist/index.html
    shim_src = target_root / "linux_renderer_shim.js"
    if not shim_src.is_file():
        shim_src = ROOT_DIR / "linux_renderer_shim.js"
    if not shim_src.is_file():
        raise RuntimeError(f"Missing linux_renderer_shim.js in {target_root} or {ROOT_DIR}")

    shim_dst = dist_dir / "linux_renderer_shim.js"
    shutil.copy2(shim_src, shim_dst)
    touched.append(shim_dst)

    index_html = dist_dir / "index.html"
    if index_html.is_file():
        html = index_html.read_text(encoding="utf-8")
        if "linux_renderer_shim.js" not in html:
            tag = '<script src="./linux_renderer_shim.js"></script>'
            new_html, n_rep = re.subn(
                r"(<head(?:\s[^>]*)?>)",
                rf"\1\n    {tag}",
                html,
                count=1,
                flags=re.IGNORECASE,
            )
            if n_rep == 0:
                new_html = f"{tag}\n{html}"
            index_html.write_text(new_html, encoding="utf-8")

    # 2. Best-effort legacy unobfuscated bundle patches (non-fatal on obfuscated 1.3.9+ builds)
    if assets_dir.is_dir():
        for p in sorted(assets_dir.glob("info-*.js")):
            s = p.read_text(encoding="utf-8", errors="ignore")
            if "usagePage===e.usagePage&&r.usage===e.usage" in s and "s&&!s.opened&&await s.open();" in s:
                s = s.replace(
                    "s&&!s.opened&&await s.open();",
                    "s&&!s.opened&&await s.open();if(s&&s.opened){try{const _syncOff=new Uint8Array(63);_syncOff[0]=23,_syncOff[4]=2,await s.sendReport(1,_syncOff)}catch{}}",
                    1,
                )
                p.write_text(s, encoding="utf-8")
                touched.append(p)

        for p in sorted(assets_dir.glob("index-*.js")):
            s = p.read_text(encoding="utf-8", errors="ignore")
            if "createI18n" not in s:
                continue
            orig_s = s
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
            if s != orig_s:
                p.write_text(s, encoding="utf-8")
                touched.append(p)

    return touched


def extract_and_build(source: Path, target_root: Path, install_sharp: bool = False) -> None:
    target_root.mkdir(parents=True, exist_ok=True)
    app_dir = target_root / "app"
    app_new = target_root / "app.new"
    app_bak = target_root / "app.bak"

    if app_new.exists():
        shutil.rmtree(app_new)
    app_new.mkdir(parents=True, exist_ok=True)

    # Ensure support scripts exist in target_root if testing an alternate directory
    if target_root.resolve() != ROOT_DIR.resolve():
        for fname in (
            "linux_updater.mjs",
            "linux_main_shim.mjs",
            "linux_renderer_shim.js",
            "linux_gif_daemon.mjs",
            "patch_notifications_en.mjs",
        ):
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
    ensure_linux_sharp(app_new, app_dir, install_sharp=install_sharp)

    patched_files: list[Path] = [
        patch_icon_worker(app_new),
        *patch_main_mjs(app_new),
        *patch_frontend_assets(app_new, target_root),
    ]

    patch_notif_script = target_root / "patch_notifications_en.mjs"
    if not patch_notif_script.is_file():
        patch_notif_script = ROOT_DIR / "patch_notifications_en.mjs"
    if patch_notif_script.is_file():
        node_bin_notif = find_node()
        notif_res = subprocess.run(
            [node_bin_notif, str(patch_notif_script), str(app_new)],
            capture_output=True,
            text=True,
            check=True,
        )
        if notif_res.stdout:
            print(notif_res.stdout.rstrip())
        for line in notif_res.stdout.splitlines():
            if line.startswith(" - "):
                rel = line[3:].strip()
                cand = app_new / rel
                if cand.is_file() and cand.suffix in (".js", ".mjs") and cand not in patched_files:
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


def get_cache_dir() -> Path:
    override = os.environ.get("AULA_UPDATE_CACHE_DIR", "").strip()
    if override:
        d = Path(override).expanduser().resolve()
    else:
        xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
        base = Path(xdg).expanduser() if xdg else (Path.home() / ".cache")
        d = (base / "aula-hub-linux").resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def has_pe_magic(file_path: Path) -> bool:
    try:
        with file_path.open("rb") as f:
            return f.read(2) == b"MZ"
    except OSError:
        return False


def verify_installer(
    file_path: Path, expected_sha256: str = "", expected_sha512: str = ""
) -> tuple[bool, str]:
    if not file_path.is_file() or file_path.stat().st_size < 1024 or not has_pe_magic(file_path):
        return False, "invalid-pe"
    if expected_sha256:
        h = hashlib.sha256()
        with file_path.open("rb") as f:
            while chunk := f.read(256 * 1024):
                h.update(chunk)
        return h.hexdigest().lower() == expected_sha256.lower(), "sha256"
    if expected_sha512:
        h = hashlib.sha512()
        with file_path.open("rb") as f:
            while chunk := f.read(256 * 1024):
                h.update(chunk)
        digest = base64.b64encode(h.digest()).decode("ascii")
        return digest == expected_sha512, "sha512"
    return True, "pe"


def probe_remote_range(url: str) -> tuple[int, bool]:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not shutil.which("curl"):
        return 0, False
    try:
        res = subprocess.run(
            [
                "curl",
                "-4",
                "--http1.1",
                "-fsSIL",
                "--connect-timeout",
                "10",
                "--max-time",
                "15",
                "-A",
                "electron-updater",
                url,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except Exception:
        return 0, False

    content_len = 0
    accept_ranges = False
    blocks = [b for b in re.split(r"\r?\n\r?\n", res.stdout.strip()) if b.strip()]
    last_block = blocks[-1] if blocks else ""
    for line in last_block.splitlines():
        low = line.lower()
        if low.startswith("content-length:"):
            try:
                content_len = int(line.split(":", 1)[1].strip())
            except ValueError:
                pass
        elif low.startswith("accept-ranges:") and "bytes" in low:
            accept_ranges = True

    if host in SINGLE_STREAM_ONLY_HOSTS:
        accept_ranges = False
    return content_len, accept_ranges


def _download_single_stream(url: str, part_path: Path) -> None:
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
                str(part_path),
                url,
            ],
            check=True,
        )
        return
    req = urllib.request.Request(url, headers={"User-Agent": "electron-updater"})
    with urllib.request.urlopen(req, timeout=120) as resp, part_path.open("wb") as out:
        while chunk := resp.read(256 * 1024):
            out.write(chunk)


def _download_parallel_ranges(
    url: str,
    part_path: Path,
    total_size: int,
    workers: int = DEFAULT_PARALLEL_WORKERS,
    chunk_size: int = DEFAULT_CHUNK_BYTES,
) -> None:
    meta_path = Path(f"{part_path}.meta.json")
    num_chunks = (total_size + chunk_size - 1) // chunk_size
    done_set: set[int] = set()

    if meta_path.is_file() and part_path.is_file() and part_path.stat().st_size == total_size:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if (
                meta.get("url") == url
                and meta.get("total") == total_size
                and meta.get("chunk_size") == chunk_size
                and isinstance(meta.get("done"), list)
            ):
                done_set = {int(i) for i in meta["done"] if 0 <= int(i) < num_chunks}
        except Exception:
            done_set = set()

    if not done_set:
        with part_path.open("wb") as f:
            f.truncate(total_size)

    pending = [i for i in range(num_chunks) if i not in done_set]
    completed_bytes = sum(
        min(chunk_size, total_size - i * chunk_size) for i in done_set
    )
    if not pending:
        meta_path.unlink(missing_ok=True)
        return

    fd = os.open(str(part_path), os.O_RDWR)
    lock = threading.Lock()
    start_ts = time.monotonic()
    downloaded_this_run = 0
    is_tty = sys.stdout.isatty()

    def save_meta() -> None:
        meta_tmp = Path(f"{meta_path}.tmp")
        meta_tmp.write_text(
            json.dumps(
                {
                    "url": url,
                    "total": total_size,
                    "chunk_size": chunk_size,
                    "done": sorted(done_set),
                }
            ),
            encoding="utf-8",
        )
        meta_tmp.replace(meta_path)

    def print_progress() -> None:
        elapsed = max(0.001, time.monotonic() - start_ts)
        speed_kbs = downloaded_this_run / 1024.0 / elapsed
        pct = min(100.0, (completed_bytes * 100.0) / total_size)
        speed_str = f"{speed_kbs / 1024.0:.2f} MB/s" if speed_kbs >= 1024 else f"{speed_kbs:.0f} KB/s"
        msg = (
            f"Downloading ({workers} streams): {pct:5.1f}% "
            f"({completed_bytes / (1024 * 1024):.1f}/{total_size / (1024 * 1024):.1f} MB) | {speed_str}"
        )
        if is_tty:
            print(f"\r{msg:<78}", end="", flush=True)
        elif len(done_set) == num_chunks or len(done_set) % max(1, num_chunks // 10) == 0:
            print(msg, flush=True)

    def fetch_chunk(idx: int) -> None:
        nonlocal completed_bytes, downloaded_this_run
        start = idx * chunk_size
        end = min(total_size - 1, start + chunk_size - 1)
        expected_len = end - start + 1
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                res = subprocess.run(
                    [
                        "curl",
                        "-4",
                        "--http1.1",
                        "-fsSL",
                        "--connect-timeout",
                        "12",
                        "--speed-limit",
                        "1024",
                        "--speed-time",
                        "25",
                        "-A",
                        "electron-updater",
                        "-r",
                        f"{start}-{end}",
                        url,
                    ],
                    capture_output=True,
                    check=True,
                )
                data = res.stdout
                if len(data) != expected_len:
                    raise RuntimeError(
                        f"Range chunk {idx} size mismatch: got {len(data)}, expected {expected_len}"
                    )
                os.pwrite(fd, data, start)
                with lock:
                    done_set.add(idx)
                    completed_bytes += expected_len
                    downloaded_this_run += expected_len
                    save_meta()
                    print_progress()
                return
            except Exception as exc:
                last_err = exc
                time.sleep(min(4.0, 0.8 * (attempt + 1)))
        raise RuntimeError(f"Chunk {idx} failed after retries: {last_err}")

    try:
        if done_set:
            print(
                f"Resuming cached download: {len(done_set)}/{num_chunks} chunks already complete"
            )
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(fetch_chunk, i) for i in pending]
            for fut in concurrent.futures.as_completed(futs):
                fut.result()
        if is_tty:
            print("")
        meta_path.unlink(missing_ok=True)
    finally:
        os.close(fd)


def prune_old_cached_installers(cache_dir: Path, keep_path: Path) -> None:
    try:
        for item in cache_dir.glob("aula-hub-update-*"):
            if item.resolve() == keep_path.resolve():
                continue
            if item.is_file():
                item.unlink(missing_ok=True)
    except Exception:
        pass


def download_and_verify_latest(
    dest_dir: Path,
    workers: int = DEFAULT_PARALLEL_WORKERS,
    chunk_size: int = DEFAULT_CHUNK_BYTES,
) -> tuple[dict[str, str], Path]:
    info = fetch_latest_info()
    url = info.get("url") or urllib.parse.urljoin(UPDATE_BASE_URL, urllib.parse.quote(info["path"]))
    safe_ver = re.sub(r"[^a-zA-Z0-9._-]", "_", info["version"])
    dest = dest_dir / f"aula-hub-update-{safe_ver}.exe"
    expected_sha256 = info.get("sha256", "")
    expected_sha512 = info.get("sha512", "")

    if dest.is_file():
        ok, alg = verify_installer(dest, expected_sha256, expected_sha512)
        if ok:
            print(f"Reused verified cached installer {dest} ({alg} OK)")
            return info, dest
        dest.unlink(missing_ok=True)

    part_path = Path(f"{dest}.part")
    print(f"Downloading {info['version']} from {url} ...")

    total_size, supports_ranges = probe_remote_range(url)
    used_parallel = False
    if supports_ranges and workers > 1 and total_size >= chunk_size:
        try:
            _download_parallel_ranges(
                url, part_path, total_size, workers=workers, chunk_size=chunk_size
            )
            used_parallel = True
        except Exception as exc:
            print(
                f"\nParallel download interrupted ({exc}); falling back to single-stream resume...",
                file=sys.stderr,
            )
            Path(f"{part_path}.meta.json").unlink(missing_ok=True)
            part_path.unlink(missing_ok=True)

    if not used_parallel:
        _download_single_stream(url, part_path)

    ok, alg = verify_installer(part_path, expected_sha256, expected_sha512)
    if not ok:
        part_path.unlink(missing_ok=True)
        Path(f"{part_path}.meta.json").unlink(missing_ok=True)
        raise RuntimeError(f"Checksum/PE verification failed ({alg}) on downloaded installer")

    part_path.replace(dest)
    print(f"Downloaded and verified {dest} ({alg} OK)")
    return info, dest


def main() -> int:
    parser = argparse.ArgumentParser(description="Native Linux updater/patcher for AULA HUB")
    parser.add_argument("source", nargs="?", help="Path to Aula Hub Setup .exe or .zip")
    parser.add_argument("--check", action="store_true", help="Check current vs latest version")
    parser.add_argument("--latest", action="store_true", help="Download latest installer and apply")
    parser.add_argument("--wait-pid", type=int, default=0, help="Wait for running PID to exit before swap")
    parser.add_argument("--relaunch", action="store_true", help="Relaunch aula-hub after update")
    parser.add_argument("--target-dir", default=str(ROOT_DIR), help="Target directory containing app/")
    parser.add_argument("--workers", type=int, default=DEFAULT_PARALLEL_WORKERS, help="Parallel HTTP range connections")
    parser.add_argument("--no-cache", action="store_true", help="Remove downloaded installer after successful install")
    parser.add_argument("--with-sharp", action="store_true", help="Also install Linux sharp binary via npm")
    args = parser.parse_args()

    target_root = Path(args.target_dir).resolve()

    if args.check:
        pkg = target_root / "app" / "package.json"
        cur_ver = json.loads(pkg.read_text(encoding="utf-8")).get("version", "unknown") if pkg.is_file() else "none"
        info = fetch_latest_info()
        print(f"Current version: {cur_ver}")
        print(f"Latest version:  {info.get('version')} ({info.get('url') or info.get('path')}, size={info.get('size', 'unknown')})")
        return 0

    if args.wait_pid > 0:
        wait_for_pid_exit(args.wait_pid)

    cache_dir = get_cache_dir()
    downloaded_to_cache = False
    if args.latest:
        _, src_path = download_and_verify_latest(cache_dir, workers=max(1, args.workers))
        downloaded_to_cache = True
    elif args.source:
        src_path = Path(args.source).resolve()
        if not src_path.is_file():
            raise FileNotFoundError(f"Installer not found: {src_path}")
    else:
        parser.error("Provide an installer path, --check, or --latest")

    extract_and_build(src_path, target_root, install_sharp=args.with_sharp)

    if downloaded_to_cache:
        if args.no_cache:
            src_path.unlink(missing_ok=True)
        else:
            prune_old_cached_installers(cache_dir, src_path)

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
