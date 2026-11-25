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
node --check "$ROOT_DIR/patch_notifications_en.mjs"

# Ensure no personal /home/<user> path or binary artifacts leaked into tracked files
FORBIDDEN_HOME="/home/""tomato"
while IFS= read -r -d '' f; do
  case "$f" in
    ./app/*|./app.new/*|./app.bak/*|./.git/*|./__pycache__/*|./tests/run_tests.sh) continue ;;
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
import sys
sys.path.insert(0, "$ROOT_DIR")
import apply_update
parsed = apply_update.parse_latest_yml("version: 1.3.9\npath: 'Aula Hub Setup 1.3.9.exe'\nsize: 151678224\nsha512: 'abc=='\n")
assert parsed["version"] == "1.3.9"
assert parsed["path"] == "Aula Hub Setup 1.3.9.exe"
assert parsed["size"] == "151678224"
assert parsed["sha512"] == "abc=="
print("parse_latest_yml OK")
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

  console.log("Local HTTP/1.1 check + download + cache + 206 resume + cancel OK");
} finally {
  server.close();
}
EOF

echo "=== 5. install.sh & uninstall.sh Integration Test ==="
INST_PREFIX="$TMP_DIR/inst"
FAKE_HOME="$TMP_DIR/home"
mkdir -p "$FAKE_HOME"
HOME="$FAKE_HOME" "$ROOT_DIR/install.sh" --prefix "$INST_PREFIX" --no-download --skip-udev
test -x "$INST_PREFIX/aula-hub"
test -L "$FAKE_HOME/.local/bin/aula-hub"
test -f "$FAKE_HOME/.local/share/applications/aula-hub.desktop"
grep -q "Exec=$INST_PREFIX/aula-hub" "$FAKE_HOME/.local/share/applications/aula-hub.desktop"

HOME="$FAKE_HOME" "$ROOT_DIR/uninstall.sh" --prefix "$INST_PREFIX"
test ! -e "$INST_PREFIX"
test ! -L "$FAKE_HOME/.local/bin/aula-hub"
test ! -f "$FAKE_HOME/.local/share/applications/aula-hub.desktop"
echo "install.sh & uninstall.sh OK"

echo ""
echo "ALL TESTS PASSED!"
