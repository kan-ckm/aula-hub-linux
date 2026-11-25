#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=== 1. Syntax & Hygiene Checks ==="
bash -n "$ROOT_DIR/aula-hub"
bash -n "$ROOT_DIR/install.sh"
bash -n "$ROOT_DIR/uninstall.sh"
bash -n "$ROOT_DIR/scripts/release.sh"
bash -n "$ROOT_DIR/tests/run_tests.sh"
bash -n "$ROOT_DIR/.githooks/pre-push"

python3 -m py_compile "$ROOT_DIR/apply_update.py"
node --check "$ROOT_DIR/linux_updater.mjs"
node --check "$ROOT_DIR/linux_main_shim.mjs"
node --check "$ROOT_DIR/linux_renderer_shim.js"
node --check "$ROOT_DIR/linux_gif_daemon.mjs"
node --check "$ROOT_DIR/patch_notifications_en.mjs"

# Ensure no personal /home/<user> path or binary artifacts leaked into tracked files
FORBIDDEN_HOME="/home/""tomato"
while IFS= read -r -d '' f; do
  case "$f" in
    ./app/*|./app.new/*|./app.bak/*|./.git/*|./__pycache__/*|./graphify-out/*|./tests/run_tests.sh) continue ;;
  esac
  if grep -q "$FORBIDDEN_HOME" "$f"; then
    echo "FAIL: Forbidden personal path found in $f" >&2
    exit 1
  fi
done < <(find . -maxdepth 3 -type f -print0)

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_BAD="$(git ls-files | grep -E '^(app/|app\.new/|app\.bak/)|(\.(exe|zip|7z|part|log)$)' || true)"
  if [[ -n "$TRACKED_BAD" ]]; then
    echo "FAIL: Proprietary/binary files tracked by git:" >&2
    echo "$TRACKED_BAD" >&2
    exit 1
  fi
fi
echo "Syntax & hygiene OK"

echo "=== 2. apply_update.py CLI & Parser Test ==="
python3 "$ROOT_DIR/apply_update.py" --help >/dev/null
python3 - <<PY
import hashlib, http.server, json, os, sys, tempfile, threading
from pathlib import Path
sys.path.insert(0, "$ROOT_DIR")
import apply_update

parsed = apply_update.parse_latest_yml("version: 1.3.9\npath: 'Aula Hub Setup 1.3.9.exe'\nsize: 151678224\nsha512: 'abc=='\n")
assert parsed["version"] == "1.3.9"
assert parsed["path"] == "Aula Hub Setup 1.3.9.exe"
assert parsed["size"] == "151678224"
assert parsed["sha512"] == "abc=="

hub_parsed = apply_update.parse_hub_version_json(json.dumps({
    "code": 1,
    "data": {
        "version": "2.9.0",
        "url": "https://cdn.aulacn.com/client/clientBase/Aula Hub Setup 2.9.0.exe",
        "sha256": "AABBCC",
        "size": "185.20 MB",
    },
}))
assert hub_parsed["version"] == "2.9.0"
assert hub_parsed["url"] == "https://cdn.aulacn.com/client/clientBase/Aula%20Hub%20Setup%202.9.0.exe"
assert hub_parsed["sha256"] == "aabbcc"

rel_parsed = apply_update.parse_hub_version_json(json.dumps({
    "code": 1,
    "data": {"version": "2.9.1", "url": "client/Setup 2.9.1.exe", "sha256": "1122"},
}))
assert rel_parsed["url"] == "https://hubapi.aulacn.com/files/client/Setup%202.9.1.exe"

# Local HTTP server test for parallel Range download, chunk resume, and cache hit
payload = bytearray(256 * 1024)
for i in range(len(payload)):
    payload[i] = (i * 17 + 3) & 0xFF
payload[0:2] = b"MZ"
payload_bytes = bytes(payload)
sha256_hex = hashlib.sha256(payload_bytes).hexdigest()
stats = {"head": 0, "range": 0, "full": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass
    def do_HEAD(self):
        stats["head"] += 1
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload_bytes)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
    def do_GET(self):
        if self.path == "/api/new":
            body = json.dumps({
                "code": 1,
                "data": {
                    "version": "2.9.0",
                    "url": f"http://127.0.0.1:{port}/Aula%20Hub%20Setup%202.9.0.exe",
                    "sha256": sha256_hex,
                },
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/Aula%20Hub%20Setup%202.9.0.exe":
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                stats["range"] += 1
                s_str, e_str = rng[6:].split("-", 1)
                s = int(s_str)
                e = int(e_str) if e_str else len(payload_bytes) - 1
                chunk = payload_bytes[s : e + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {s}-{e}/{len(payload_bytes)}")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return
            stats["full"] += 1
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload_bytes)))
            self.end_headers()
            self.wfile.write(payload_bytes)
            return
        self.send_response(404)
        self.end_headers()

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
th = threading.Thread(target=srv.serve_forever, daemon=True)
th.start()

old_api = os.environ.get("AULA_UPDATE_API_URL")
os.environ["AULA_UPDATE_API_URL"] = f"http://127.0.0.1:{port}/api/new"
apply_update.NEW_VERSION_API_URL = os.environ["AULA_UPDATE_API_URL"]
try:
    with tempfile.TemporaryDirectory() as cache_td:
        cdir = Path(cache_td)
        # 1. Parallel 4-chunk download
        info, dest = apply_update.download_and_verify_latest(cdir, workers=4, chunk_size=65536)
        assert info["version"] == "2.9.0"
        assert dest.read_bytes() == payload_bytes
        assert stats["range"] == 4, f"Expected 4 range chunks, got {stats}"

        # 2. Cached fast-path (no additional range requests)
        prev_range = stats["range"]
        _, dest2 = apply_update.download_and_verify_latest(cdir, workers=4, chunk_size=65536)
        assert dest2 == dest and stats["range"] == prev_range

        # 3. Chunk-level resume from .part + .meta.json (2 of 4 chunks already done)
        dest.unlink()
        part = Path(f"{dest}.part")
        buf = bytearray(len(payload_bytes))
        buf[0 : 2 * 65536] = payload_bytes[0 : 2 * 65536]
        part.write_bytes(bytes(buf))
        Path(f"{part}.meta.json").write_text(json.dumps({
            "url": info["url"],
            "total": len(payload_bytes),
            "chunk_size": 65536,
            "done": [0, 1],
        }), encoding="utf-8")
        _, dest3 = apply_update.download_and_verify_latest(cdir, workers=4, chunk_size=65536)
        assert dest3.read_bytes() == payload_bytes
        assert stats["range"] == prev_range + 2, f"Expected 2 resumed chunks, got {stats}"
finally:
    srv.shutdown()
    if old_api is None:
        os.environ.pop("AULA_UPDATE_API_URL", None)
    else:
        os.environ["AULA_UPDATE_API_URL"] = old_api

print("parse_latest_yml + hubapi + parallel Range download/cache/resume OK")
PY

echo "=== 3. patch_notifications_en.mjs Fixture & Idempotency Test ==="
FIX_APP="$TMP_DIR/fixture-app"
mkdir -p "$FIX_APP/dist/assets" "$FIX_APP/dist-electron"

cat > "$FIX_APP/dist/assets/index-test123.js" <<'EOF'
const i18n = createI18n({legacy:!1,locale:"zh",fallbackLocale:"zh"});
let TM=0;const El={value:[]};
function Re(n,e="success",t=3e3){const i=TM++;El.value.push({id:i,message:n,type:e,leaving:!1}),!(t<=0)&&setTimeout(()=>{const r=El.value.findIndex(a=>a.id===i);r!==-1&&(El.value[r].leaving=!0)},t)}
function tip(n,e,t){return`Aula Hub - ${t?`${t} `:""}电量: ${n}%${e?" (充电中)":""}`}
const ask="请输入新建配置名";
EOF

cat > "$FIX_APP/dist/assets/element-plus-test123.js" <<'EOF'
const loc={image:{error:"加载失败"},pageHeader:{title:"返回"},popconfirm:{confirmButtonText:"确定",cancelButtonText:"取消"},dialog:{close:"关闭此对话框"},drawer:{close:"关闭此对话框"},messagebox:{title:"提示",confirm:"确定",cancel:"取消",error:"输入的数据不合法!",close:"关闭此对话框"},select:{loading:"加载中",noMatch:"无匹配数据",noData:"无数据",placeholder:"请选择"}};
EOF

cat > "$FIX_APP/dist/assets/key-test123.js" <<'EOF'
async function warnMacro(){return f.confirm("宏命令步骤最多 20 组动作","提示",{confirmButtonText:"确认",showCancel:!1});}
EOF

cat > "$FIX_APP/dist/assets/softwarePicker-test123.js" <<'EOF'
const opts={title:"选择应用程序",filterExeName:"可执行文件 (*.exe)",filterAllName:"所有文件 (*.*)"};
EOF

cat > "$FIX_APP/dist/assets/info-test123.js" <<'EOF'
const x="设备按键列表未初始化";async function imp(k){await k("导入宏配置...");await k("导入SOCD配置...");}
EOF

cat > "$FIX_APP/dist-electron/main.mjs" <<'EOF'
let fr = { show: "显示", exit: "退出", stopGsi: "停止 GameSense 服务" };
function fmt(f, p){ return [`已切换为【板载配置${f}】`, `已切换为板载配置${Number(p.configIndex) + 1}`]; }
const dlg = { title: "选择固件文件", name: "固件文件", err: "网络连接失败，请检查网络" };
EOF

OUT1="$(node "$ROOT_DIR/patch_notifications_en.mjs" "$FIX_APP")"
echo "$OUT1"
echo "$OUT1" | grep -q "6 file(s) updated"

OUT2="$(node "$ROOT_DIR/patch_notifications_en.mjs" "$FIX_APP")"
echo "$OUT2"
echo "$OUT2" | grep -q "0 file(s) updated"

node --check "$FIX_APP/dist/assets/index-test123.js"
node --check "$FIX_APP/dist/assets/element-plus-test123.js"
node --check "$FIX_APP/dist/assets/key-test123.js"
node --check "$FIX_APP/dist/assets/softwarePicker-test123.js"
node --check "$FIX_APP/dist/assets/info-test123.js"
node --check "$FIX_APP/dist-electron/main.mjs"

node --input-type=module - "$FIX_APP/dist/assets/index-test123.js" <<'EOF'
import fs from "node:fs";
import vm from "node:vm";
const txt = fs.readFileSync(process.argv[2], "utf8");
const start = txt.indexOf("/*__EN_TOAST_PATCHED__*/");
const end = txt.indexOf("function Re(", start);
if (start === -1 || end === -1) throw new Error("Missing EN toast patch");
let lang = "en";
const ctx = vm.createContext({ localStorage: { getItem: () => JSON.stringify({ language: lang }) } });
vm.runInContext(txt.slice(start, end) + "\nthis._enTrMsg = _enTrMsg;", ctx);
const enOut = ctx._enTrMsg("登录失败，邮件或密码错误");
if (enOut !== "Login failed: incorrect email or password") throw new Error("Unexpected EN output: " + enOut);
lang = "zh";
const zhOut = ctx._enTrMsg("登录失败，邮件或密码错误");
if (zhOut !== "登录失败，邮件或密码错误") throw new Error("Unexpected ZH output: " + zhOut);
console.log("_enTrMsg EN/ZH runtime test OK");
EOF

echo "=== 4. linux_updater.mjs Local HTTP/1.1 Stream, Resume & Cancel Test ==="
UPD_CACHE="$TMP_DIR/updater-cache"
mkdir -p "$UPD_CACHE"
AULA_UPDATE_CACHE_DIR="$UPD_CACHE" node --input-type=module - "$ROOT_DIR/linux_updater.mjs" "$UPD_CACHE" <<'EOF'
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const updaterFile = process.argv[2];
const cacheDir = process.argv[3];

const payload = Buffer.alloc(256 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
payload.write("MZ", 0, "ascii");
const sha512 = crypto.createHash("sha512").update(payload).digest("base64");
const yml = [
  "version: 9.9.9",
  "path: Test Setup 9.9.9.exe",
  `size: ${payload.length}`,
  `sha512: ${sha512}`,
].join("\n");

let rangeRequestsSeen = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/latest.yml") {
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end(yml);
    return;
  }
  if (req.url === "/Test%20Setup%209.9.9.exe") {
    const range = req.headers.range;
    if (range) {
      rangeRequestsSeen++;
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416);
        res.end();
        return;
      }
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : payload.length - 1;
      if (start >= payload.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      const slice = payload.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${payload.length}`,
        "ETag": '"test-999"',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": payload.length,
      "Accept-Ranges": "bytes",
      "ETag": '"test-999"',
    });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
process.env.AULA_UPDATE_BASE_URL = `http://127.0.0.1:${port}/`;

try {
  const { registerLinuxUpdater } = await import(pathToFileURL(updaterFile).href);
  const handlers = new Map();
  const events = [];
  registerLinuxUpdater({
    app: { getVersion: () => "1.1.22", getPath: () => cacheDir, quit: () => {} },
    ipcMain: { handle: (c, f) => handlers.set(c, f), on: (c, f) => handlers.set(c, f) },
    net: null,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c, ...a) => events.push([c, ...a]) } }),
    log: () => {},
    onBeforeQuitForUpdate: () => {},
  });

  const info = await handlers.get("update:check")();
  if (!info || info.version !== "9.9.9") throw new Error("update:check failed");

  // 1. Fresh download + SHA-512 verify
  const outPath = await handlers.get("update:download")();
  if (!fs.readFileSync(outPath).equals(payload)) throw new Error("Downloaded bytes mismatch");
  if (!events.some((e) => e[0] === "update-downloaded")) throw new Error("Missing update-downloaded event");

  // 2. Cached fast-path reuse
  const cachedOut = await handlers.get("update:download")();
  if (cachedOut !== outPath) throw new Error("Cached fast-path failed");

  // 3. Partial .part resume via 206 Partial Content
  fs.unlinkSync(outPath);
  const partPath = `${outPath}.part`;
  fs.writeFileSync(partPath, payload.subarray(0, 65536));
  const resumedOut = await handlers.get("update:download")();
  if (rangeRequestsSeen < 1) throw new Error("Expected Range 206 resume request");
  if (!fs.readFileSync(resumedOut).equals(payload)) throw new Error("Resumed payload mismatch");

  // 4. Cancel removes .part
  fs.unlinkSync(resumedOut);
  await handlers.get("update:cancel-download")();
  if (fs.existsSync(partPath)) throw new Error(".part still exists after cancel");

  // 5. Direct URL + SHA-256 download (AULA HUB 1.3.9+ contract)
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const directUrl = `http://127.0.0.1:${port}/Test%20Setup%209.9.9.exe`;
  const directOut = await handlers.get("update:download")(null, directUrl, sha256);
  if (!fs.readFileSync(directOut).equals(payload)) throw new Error("Direct SHA-256 download bytes mismatch");
  fs.unlinkSync(directOut);

  // 6. Direct URL SHA-256 mismatch rejects
  let badRejected = false;
  try {
    await handlers.get("update:download")(null, directUrl, "0".repeat(64));
  } catch (err) {
    badRejected = String(err.message || err).includes("SHA256 mismatch");
  }
  if (!badRejected) throw new Error("Expected SHA256 mismatch error");

  console.log("Local HTTP/1.1 check + download (SHA-512 & direct SHA-256) + cache + 206 resume + cancel OK");
} finally {
  server.close();
}
EOF

echo "=== 4b. Obfuscated 1.3.9+ Patcher & Runtime Shim Tests ==="
OBF_ROOT="$TMP_DIR/obf-root"
OBF_APP="$OBF_ROOT/app.new"
mkdir -p "$OBF_APP/dist-electron" "$OBF_APP/dist/assets"
cp "$ROOT_DIR/linux_main_shim.mjs" "$ROOT_DIR/linux_renderer_shim.js" "$ROOT_DIR/linux_updater.mjs" "$ROOT_DIR/linux_gif_daemon.mjs" "$OBF_ROOT/"
cat > "$OBF_APP/dist-electron/iconWorker.mjs" <<'EOF'
function _0x4209(a,b){return"";}console.log("obf-icon-worker");
EOF
cat > "$OBF_APP/dist-electron/main.mjs" <<'EOF'
function _0x1183(a,b){return"";}console.log("obf-main");
EOF
cat > "$OBF_APP/dist/index.html" <<'EOF'
<!doctype html><html><head><title>AULA HUB</title></head><body><div id="app"></div></body></html>
EOF
cat > "$OBF_APP/dist/assets/index-OBF123.js" <<'EOF'
function _0x180d(a){return"";}console.log("obf-renderer");
EOF
cat > "$OBF_APP/dist/assets/element-plus-OBF123.js" <<'EOF'
const loc={image:{error:"加载失败"},pageHeader:{title:"返回"}};
EOF

python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$ROOT_DIR")
import apply_update
app_new = Path("$OBF_APP")
target_root = Path("$OBF_ROOT")
iw = apply_update.patch_icon_worker(app_new)
mn = apply_update.patch_main_mjs(app_new)
fe = apply_update.patch_frontend_assets(app_new, target_root)
assert (app_new / "dist-electron" / "iconWorker.orig.mjs").is_file()
assert (app_new / "dist-electron" / "main.orig.mjs").is_file()
assert "linux_renderer_shim.js" in (app_new / "dist" / "index.html").read_text(encoding="utf-8")
assert (app_new / "dist" / "linux_renderer_shim.js").is_file()
print("apply_update obfuscated fixture patch OK")
PY

node "$ROOT_DIR/patch_notifications_en.mjs" "$OBF_APP"
grep -q 'Failed to load' "$OBF_APP/dist/assets/element-plus-OBF123.js"
node --check "$OBF_APP/dist-electron/iconWorker.mjs"
node --check "$OBF_APP/dist-electron/main.mjs"
node --check "$OBF_APP/dist/linux_renderer_shim.js"

# Test Linux iconWorker runtime protocol & linux_main_shim helpers & linux_renderer_shim
node --input-type=module - "$ROOT_DIR" "$OBF_APP" "$TMP_DIR" <<'EOF'
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const rootDir = process.argv[2];
const obfApp = process.argv[3];
const tmpDir = process.argv[4];

// 1. Test linux_main_shim translation helpers
const { translateMainText, translateMenuTemplate, translateDialogOptions } = await import(
  pathToFileURL(path.join(rootDir, "linux_main_shim.mjs")).href
);
if (translateMainText("Aula Hub - WIN 68 HE 电量: 85% (充电中)") !== "Aula Hub - WIN 68 HE Battery: 85% (Charging)") {
  throw new Error("Battery tooltip translation failed");
}
if (translateMainText("已切换为【板载配置2】") !== "Switched to [Profile 2]") {
  throw new Error("Profile switch translation failed");
}
const menu = translateMenuTemplate([{ label: "显示" }, { label: "退出" }]);
if (menu[0].label !== "Show" || menu[1].label !== "Exit") throw new Error("Menu translation failed");
const dlg = translateDialogOptions({ title: "选择固件文件", filters: [{ name: "固件文件", extensions: ["bin"] }] });
if (dlg.title !== "Select Firmware File" || dlg.filters[0].name !== "Firmware Files") {
  throw new Error("Dialog translation failed");
}

// 2. Test iconWorker.mjs Linux runtime protocol
const messages = [];
const port = new EventEmitter();
port.postMessage = (msg) => messages.push(msg);
process.parentPort = port;
await import(pathToFileURL(path.join(obfApp, "dist-electron", "iconWorker.mjs")).href);
await new Promise((r) => setImmediate(r));
if (!messages.some((m) => m.type === "worker-ready")) throw new Error("Missing worker-ready");

port.emit("message", { data: { type: "run-ps", id: 1, script: "Get-Process" } });
const psRes = messages.find((m) => m.type === "ps-result" && m.id === 1);
if (!psRes || !psRes.error) throw new Error("Missing ps-result error");

const samplePng = path.join(tmpDir, "icon.png");
fs.writeFileSync(samplePng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
port.emit("message", { data: { type: "extract-icon", id: 2, filePath: samplePng } });
const iconRes = messages.find((m) => m.type === "icon-result" && m.id === 2);
if (!iconRes || !iconRes.dataUrl.startsWith("data:image/png;base64,")) {
  throw new Error("Icon extraction failed");
}

port.emit("message", { data: { type: "extract-icon", id: 3, filePath: "/nonexistent.png" } });
const missRes = messages.find((m) => m.type === "icon-result" && m.id === 3);
if (!missRes || missRes.dataUrl !== "") throw new Error("Missing file icon should return empty string");

// 3. Test linux_renderer_shim.js (default EN + WIN 68 HE HID sync-off + EN/ZH msg translation)
const store = new Map();
const sentReports = [];
class MockHIDDevice {
  constructor(vendorId, productId, collections) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.collections = collections;
    this.opened = false;
  }
  async open() { this.opened = true; }
  async sendReport(id, data) { sentReports.push({ vid: this.vendorId, pid: this.productId, id, data: [...data] }); }
}
const ctx = vm.createContext({
  window: {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  },
  HIDDevice: MockHIDDevice,
  Uint8Array,
});
vm.runInContext(fs.readFileSync(path.join(rootDir, "linux_renderer_shim.js"), "utf8"), ctx);
const seeded = JSON.parse(store.get("aula-store"));
if (seeded.language !== "en") throw new Error("Expected default language en");
if (ctx.window.__aulaEnTrMsg("登录失败，邮件或密码错误") !== "Login failed: incorrect email or password") {
  throw new Error("Renderer EN translation failed");
}
store.set("aula-store", JSON.stringify({ language: "zh" }));
if (ctx.window.__aulaEnTrMsg("登录失败，邮件或密码错误") !== "登录失败，邮件或密码错误") {
  throw new Error("Renderer ZH passthrough failed");
}

const rlwDev = new MockHIDDevice(0x2e3c, 0xc365, [{ usagePage: 0xff1b, usage: 0x91 }]);
await rlwDev.open();
const otherDev = new MockHIDDevice(0x38a6, 0x2711, [{ usagePage: 0xff00, usage: 0x01 }]);
await otherDev.open();
if (sentReports.length !== 1 || sentReports[0].id !== 1 || sentReports[0].data[0] !== 23 || sentReports[0].data[4] !== 2) {
  throw new Error("WIN 68 HE sync-off packet test failed");
}
console.log("Obfuscated 1.3.9+ shims & iconWorker runtime tests OK");
EOF

echo "=== 4c. 2.9.0+ CJS + V8 Bytecode Loader Patch Test ==="
CJS_ROOT="$TMP_DIR/cjs-root"
CJS_APP="$CJS_ROOT/app.new"
mkdir -p "$CJS_APP/dist-electron" "$CJS_APP/dist/assets"
cp "$ROOT_DIR/linux_main_shim.mjs" "$ROOT_DIR/linux_renderer_shim.js" "$ROOT_DIR/linux_updater.mjs" "$ROOT_DIR/linux_gif_daemon.mjs" "$CJS_ROOT/"
cat > "$CJS_APP/dist-electron/iconWorker.mjs" <<'EOF'
console.log("orig-icon-worker");
EOF
cat > "$CJS_APP/dist-electron/main.cjs" <<'EOF'
'use strict';
require('./bytecode-loader.cjs');
require('./main.jsc');
EOF
cat > "$CJS_APP/dist-electron/bytecode-loader.cjs" <<'EOF'
'use strict';
const FLAG_HASH_OFFSET = 12;
let dummyBytecode = null;
function setFlagHashHeader(bytecodeBuffer) {
  Buffer.from(dummyBytecode).copy(bytecodeBuffer, FLAG_HASH_OFFSET, FLAG_HASH_OFFSET, FLAG_HASH_OFFSET + 4);
}
module.exports = { setFlagHashHeader };
EOF
cat > "$CJS_APP/dist/index.html" <<'EOF'
<!doctype html><html><head><title>AULA HUB</title></head><body><div id="app"></div></body></html>
EOF

python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$ROOT_DIR")
import apply_update
app_new = Path("$CJS_APP")
target_root = Path("$CJS_ROOT")
iw = apply_update.patch_icon_worker(app_new)
mains = apply_update.patch_main_mjs(app_new)
fe = apply_update.patch_frontend_assets(app_new, target_root)
assert (app_new / "dist-electron" / "main.orig.cjs").is_file()
assert "main.orig.cjs" in (app_new / "dist-electron" / "main.cjs").read_text(encoding="utf-8")
loader_txt = (app_new / "dist-electron" / "bytecode-loader.cjs").read_text(encoding="utf-8")
assert "FLAG_HASH_OFFSET + 8" in loader_txt
assert "readUInt32LE(4)" in loader_txt
assert len(mains) == 2
print("apply_update 2.9.0+ CJS+bytecode patch OK")
PY

node "$ROOT_DIR/patch_notifications_en.mjs" "$CJS_APP"
node --check "$CJS_APP/dist-electron/main.cjs"
node --check "$CJS_APP/dist-electron/bytecode-loader.cjs"
echo "2.9.0+ CJS+bytecode syntax & patcher tests OK"

echo "=== 5. install.sh & uninstall.sh Integration Test ==="
INST_PREFIX="$TMP_DIR/inst"
FAKE_HOME="$TMP_DIR/home"
mkdir -p "$FAKE_HOME"
HOME="$FAKE_HOME" "$ROOT_DIR/install.sh" --prefix "$INST_PREFIX" --no-download --skip-udev
test -x "$INST_PREFIX/aula-hub"
test -f "$INST_PREFIX/linux_main_shim.mjs"
test -f "$INST_PREFIX/linux_renderer_shim.js"
test -x "$INST_PREFIX/linux_gif_daemon.mjs"
test -L "$FAKE_HOME/.local/bin/aula-hub"
test -f "$FAKE_HOME/.local/share/applications/aula-hub.desktop"
grep -q "Exec=$INST_PREFIX/aula-hub" "$FAKE_HOME/.local/share/applications/aula-hub.desktop"

HOME="$FAKE_HOME" "$ROOT_DIR/uninstall.sh" --prefix "$INST_PREFIX"
test ! -e "$INST_PREFIX"
test ! -L "$FAKE_HOME/.local/bin/aula-hub"
test ! -f "$FAKE_HOME/.local/share/applications/aula-hub.desktop"
echo "install.sh & uninstall.sh OK"

echo "=== 5b. Lightweight GIF Daemon & Handoff Tests ==="
GIF_TEST_DIR="$TMP_DIR/gif-test"
mkdir -p "$GIF_TEST_DIR"
python3 - <<PY
# Generate a minimal valid 2-frame animated GIF89a (4x2, red -> cyan) without Pillow
from pathlib import Path

def make_test_gif(path: Path):
    # Global color table: 0=black(0,0,0), 1=red(255,0,0), 2=cyan(0,255,255), 3=white(255,255,255)
    gct = bytes([0,0,0, 255,0,0, 0,255,255, 255,255,255])
    # LZW minCodeSize=2 (clear=4, eoi=5). 8 pixels all=1 -> codes: 4, 1, 1, 1, 1, 1, 1, 1, 1, 5
    def lzw_encode_solid(val, count):
        codes = [4] + [val] * count + [5]
        bits = 0
        nbits = 0
        out = bytearray()
        code_size = 3
        next_code = 6
        for idx, c in enumerate(codes):
            bits |= (c << nbits)
            nbits += code_size
            while nbits >= 8:
                out.append(bits & 0xff)
                bits >>= 8
                nbits -= 8
            if idx >= 2 and idx < len(codes) - 1:
                next_code += 1
                if next_code == (1 << code_size) and code_size < 12:
                    code_size += 1
        if nbits > 0:
            out.append(bits & 0xff)
        return bytes([2, len(out)]) + bytes(out) + b"\x00"

    buf = bytearray(b"GIF89a")
    buf += (4).to_bytes(2, "little") + (2).to_bytes(2, "little")
    buf += bytes([0x91, 0, 0])  # GCT flag=1, size=4 colors
    buf += gct
    for color_idx in (1, 2):
        # Graphic Control Extension: delay=6 (60ms), disposal=2
        buf += bytes([0x21, 0xf9, 0x04, 0x08, 0x06, 0x00, 0x00, 0x00])
        # Image Descriptor: 4x2 at (0,0)
        buf += bytes([0x2c, 0,0, 0,0, 4,0, 2,0, 0x00])
        buf += lzw_encode_solid(color_idx, 8)
    buf += b"\x3b"
    path.write_bytes(buf)

make_test_gif(Path("$GIF_TEST_DIR/sample.gif"))
PY

node --input-type=module - "$ROOT_DIR" "$GIF_TEST_DIR/sample.gif" <<'EOF'
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const rootDir = process.argv[2];
const gifPath = process.argv[3];
const mod = await import(pathToFileURL(path.join(rootDir, "linux_gif_daemon.mjs")).href);

// 1. Report descriptor usage parser on real WIN 68 HE vendor interface descriptor
const rdesc = Buffer.from("061bff0991a101850119002aff00150026ff007508953f8102190029ff9102c0", "hex");
const usages = mod.parseReportDescriptorUsages(rdesc);
if (!usages.some((u) => u.usagePage === 0xff1b && u.usage === 0x91)) {
  throw new Error(`Expected 0xff1b:0x91 in usages, got ${JSON.stringify(usages)}`);
}

// 2. Pure-JS GIF89a decoder
const decoded = mod.decodeGif(fs.readFileSync(gifPath));
if (decoded.width !== 4 || decoded.height !== 2 || decoded.frames.length !== 2) {
  throw new Error(`Unexpected GIF decode result: ${decoded.width}x${decoded.height}, frames=${decoded.frames.length}`);
}
if (decoded.frames[0].rgba[0] !== 255 || decoded.frames[0].rgba[1] !== 0) {
  throw new Error("GIF frame 0 should be red");
}
if (decoded.frames[1].rgba[0] !== 0 || decoded.frames[1].rgba[1] !== 255 || decoded.frames[1].rgba[2] !== 255) {
  throw new Error("GIF frame 1 should be cyan");
}

// 3. Compile GIF to RLW packets for both win68 & win60 across modes
for (const layoutName of ["win68", "win60"]) {
  for (const mode of ["led", "crop", "full"]) {
    const cache = mod.compileGifToCache(gifPath, { layoutName, mode });
    if (cache.frames.length !== 2 || cache.frames[0].length !== 8 || cache.frameDelayMs !== 60) {
      throw new Error(`Invalid compiled cache for ${layoutName}/${mode}`);
    }
    const pkt0 = Buffer.from(cache.frames[0][0], "base64");
    const syncOn = Buffer.from(cache.syncOn, "base64");
    const syncOff = Buffer.from(cache.syncOff, "base64");
    if (pkt0.length !== 63 || pkt0[0] !== 0x0f || pkt0[4] !== 54) {
      throw new Error("Invalid RLW frame packet header");
    }
    if (syncOn[0] !== 0x17 || syncOn[5] !== 1 || syncOff[0] !== 0x17 || syncOff[5] !== 0) {
      throw new Error("Invalid RLW sync packets");
    }
  }
}

// 4. Test linux_renderer_shim.js sendReport capture + cycle auto-locking
const posted = [];
class MockHID {
  constructor() {
    this.vendorId = 0x2e3c;
    this.productId = 0xc365;
    this.opened = true;
    this.collections = [{ usagePage: 0xff1b, usage: 0x91 }];
  }
  async open() { return; }
  async sendReport() { return; }
}
const ctx = vm.createContext({
  window: {
    localStorage: { getItem: () => null, setItem: () => {} },
  },
  HIDDevice: MockHID,
  Uint8Array,
  ArrayBuffer,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  setTimeout,
  clearTimeout,
  fetch: async (url, opts) => {
    if (String(url).includes("/gif-handoff")) {
      posted.push(JSON.parse(opts.body));
    }
    return { ok: true };
  },
});
vm.runInContext(fs.readFileSync(path.join(rootDir, "linux_renderer_shim.js"), "utf8"), ctx);

const dev = new MockHID();
const cache = mod.compileGifToCache(gifPath, { layoutName: "win68", mode: "crop" });
await dev.sendReport(1, Buffer.from(cache.syncOn, "base64"));
// Stream 2 cycles of 2 frames (4 frames total) so cycle lock triggers at period=2
for (let rep = 0; rep < 2; rep++) {
  for (const framePkts of cache.frames) {
    for (const b64 of framePkts) {
      await dev.sendReport(1, Buffer.from(b64, "base64"));
    }
  }
}
const lastPost = posted[posted.length - 1];
if (!lastPost || !lastPost.active || lastPost.frames.length !== 2) {
  throw new Error(`Expected locked 2-frame handoff post, got: ${JSON.stringify(posted)}`);
}
console.log("Lightweight GIF daemon & renderer handoff tests OK");
EOF

echo "=== 6. udev Rules Validation ==="
RULES_FILE="$ROOT_DIR/udev/99-aula-hub.rules"
test -f "$RULES_FILE"
grep -q 'idVendor}=="2e3c".*idProduct}=="c365"' "$RULES_FILE"
# Shared VIDs (0c45, 1a86) must never appear without an idProduct filter
if grep -E 'idVendor}=="(0c45|1a86)"' "$RULES_FILE" | grep -vq 'idProduct}=="'; then
  echo "FAIL: Shared VID (0c45/1a86) found without idProduct filter" >&2
  exit 1
fi
HIDRAW_COUNT="$(grep -c '^KERNEL=="hidraw\*"' "$RULES_FILE")"
if [[ "$HIDRAW_COUNT" -lt 79 ]]; then
  echo "FAIL: Expected at least 79 hidraw rules, found $HIDRAW_COUNT" >&2
  exit 1
fi
echo "udev rules OK ($HIDRAW_COUNT hidraw rules)"

echo ""
echo "ALL TESTS PASSED!"
