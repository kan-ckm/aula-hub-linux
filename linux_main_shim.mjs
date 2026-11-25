/**
 * Runtime Electron main-process shim for running AULA HUB natively on Linux.
 * Loaded before dist-electron/main.orig.mjs so all Linux compatibility hooks,
 * WebHID selection, resilient net.fetch, native Linux updater IPC, and English
 * UI localization work regardless of upstream bundling or JS obfuscation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerLinuxUpdater } from "./linux_updater.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const RENDERER_SHIM_PATH = path.join(ROOT_DIR, "linux_renderer_shim.js");
const SHIM_SCRIPT_TAG = '<script src="aula://__linux_shim__/renderer_shim.js"></script>';

const MAIN_EXACT_EN = {
  "显示": "Show",
  "退出": "Exit",
  "停止 GameSense 服务": "Stop GameSense Service",
  "选择可执行文件": "Select Executable",
  "选择应用程序": "Select Application",
  "可执行文件": "Executable",
  "可执行文件 (*.exe)": "Executable (*.exe)",
  "所有文件": "All Files",
  "所有文件 (*.*)": "All Files (*.*)",
  "选择遮罩图片": "Select Overlay Image",
  "图片文件": "Image Files",
  "选择固件文件": "Select Firmware File",
  "固件文件": "Firmware Files",
  "更新包格式错误，需要 .zip 文件": "Invalid update package format (.zip required)",
  "网络连接失败，请检查网络": "Network connection failed, please check your connection",
  "更新包校验失败，可能文件已损坏": "Update package verification failed; file may be corrupted",
  "更新包解压失败": "Failed to extract update package",
  "下载中断，请检查网络": "Download interrupted, please check your connection",
  "用户取消了选择": "Selection cancelled by user",
  "读取文件失败": "Failed to read file",
  "日志文件不存在": "Log file does not exist",
  "请求失败": "Request failed",
  "已有下载任务正在进行中": "A download is already in progress",
};

const UPDATE_HANDLE_CHANNELS = new Set([
  "update:check",
  "update:download",
  "update:cancel-download",
]);
const UPDATE_ON_CHANNELS = new Set(["update:quit-and-install"]);

const HEADSET_STUB_HANDLERS = new Map([
  ["headset-service-start", async () => false],
  ["headset-service-acquire", async () => false],
  ["headset-service-stop", async () => true],
  ["headset-service-release", async () => true],
  ["headset-service-status", async () => false],
  [
    "headset-service-diagnostic",
    async () => ({ running: false, autoRestartExhausted: false, failure: null }),
  ],
  ["audio-env-gate-report", async () => null],
  ["audio-env-gate-ack", async () => true],
  ["audio-env-gate-reset", async () => true],
  [
    "headset:install-drivers",
    async () => ({ success: false, error: "Headset drivers are Windows-only" }),
  ],
  [
    "headset:uninstall-drivers",
    async () => ({ success: false, error: "Headset drivers are Windows-only" }),
  ],
  ["headset:shared-driver-devices", async () => 0],
  ["headset:driver-binding", async () => null],
  ["cmxear-service-start", async () => false],
  ["cmxear-service-stop", async () => true],
  ["cmxear-service-status", async () => false],
  ["cmxear-service-endpoint", async () => null],
  ["cmxear-service-diagnostic", async () => ({ running: false, failure: null })],
  ["xii-service-start", async () => false],
  ["xii-service-stop", async () => true],
  ["xii-service-status", async () => false],
  ["xii-service-endpoint", async () => null],
  ["xii-service-diagnostic", async () => ({ running: false, failure: null })],
  ["xii-service-device-present", async () => false],
  ["xii-service-device-state", async () => null],
  [
    "xii-service-reset",
    async () => ({ success: false, error: "Headset drivers are Windows-only" }),
  ],
  ["xii-service-state", async () => null],
  [
    "xii-service-install",
    async () => ({ success: false, error: "Headset drivers are Windows-only" }),
  ],
  [
    "xii-service-ensure-audio",
    async () => ({ success: false, error: "Headset drivers are Windows-only" }),
  ],
]);

let shimInstalled = false;

export function translateMainText(text) {
  if (typeof text !== "string" || !text) return text;
  const trimmed = text.trim();
  if (MAIN_EXACT_EN[trimmed]) return MAIN_EXACT_EN[trimmed];
  if (!/[\u4e00-\u9fff]/.test(text)) return text;

  let out = text;
  // Battery tray tooltip: "Aula Hub - <dev> 电量: 85% (充电中)"
  out = out.replace(/电量:\s*(\d+)%(\s*\(充电中\))?/g, (_, pct, chg) =>
    `Battery: ${pct}%${chg ? " (Charging)" : ""}`
  );
  // Onboard profile switch notices
  out = out.replace(/已切换为【板载配置([^】]+)】/g, "Switched to [Profile $1]");
  out = out.replace(/已切换为板载配置(\S+)/g, "Switched to Profile $1");
  return out;
}

export function translateMenuTemplate(template) {
  if (!Array.isArray(template)) return template;
  return template.map((item) => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    if (typeof copy.label === "string") {
      copy.label = translateMainText(copy.label);
    }
    if (Array.isArray(copy.submenu)) {
      copy.submenu = translateMenuTemplate(copy.submenu);
    }
    return copy;
  });
}

export function translateDialogOptions(options) {
  if (!options || typeof options !== "object") return options;
  const copy = { ...options };
  if (typeof copy.title === "string") {
    copy.title = translateMainText(copy.title);
  }
  if (Array.isArray(copy.filters)) {
    copy.filters = copy.filters.map((f) =>
      f && typeof f === "object" && typeof f.name === "string"
        ? { ...f, name: translateMainText(f.name) }
        : f
    );
  }
  return copy;
}

function translateIpcResult(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  let changed = false;
  const copy = { ...val };
  for (const key of ["error", "message"]) {
    if (typeof copy[key] === "string") {
      const tr = translateMainText(copy[key]);
      if (tr !== copy[key]) {
        copy[key] = tr;
        changed = true;
      }
    }
  }
  return changed ? copy : val;
}

function isExternalHttpUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]";
  } catch {
    return false;
  }
}

function isRetryableFetchError(err) {
  const code = String(err?.cause?.code || err?.code || "");
  const msg = String(err?.message || err || "");
  return (
    /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET/i.test(
      code
    ) ||
    /timeout|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|socket hang up|fetch failed/i.test(
      msg
    )
  );
}

function injectRendererShimHtml(html) {
  if (
    html.includes("linux_renderer_shim.js") ||
    html.includes("__linux_shim__/renderer_shim.js")
  ) {
    return html;
  }
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${SHIM_SCRIPT_TAG}`);
  }
  return `${SHIM_SCRIPT_TAG}\n${html}`;
}

export async function installLinuxMainShim() {
  if (shimInstalled || process.platform !== "linux") return;
  shimInstalled = true;

  const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    net,
    Notification,
    protocol,
    session,
    Tray,
  } = await import("electron");

  // 1. Safe wrapper for app.setLoginItemSettings (unsupported on Linux)
  if (typeof app.setLoginItemSettings === "function") {
    const origSetLogin = app.setLoginItemSettings.bind(app);
    app.setLoginItemSettings = (...args) => {
      try {
        return origSetLogin(...args);
      } catch {
        return undefined;
      }
    };
  }

  // 2. WebHID select-hid-device auto-selector on all sessions
  const attachHidSelector = (sess) => {
    if (!sess || typeof sess.on !== "function") return;
    if (typeof sess.listenerCount === "function" && sess.listenerCount("select-hid-device") > 0) {
      return;
    }
    sess.on("select-hid-device", (event, details, callback) => {
      event.preventDefault();
      const list = (details && details.deviceList) || [];
      const pref =
        list.find(
          (item) =>
            Array.isArray(item.collections) &&
            item.collections.some((c) => c.usagePage >= 65280)
        ) || list[0];
      callback(pref ? pref.deviceId : "");
    });
  };

  app.on("session-created", attachHidSelector);
  app.on("web-contents-created", (_ev, wc) => {
    if (wc && wc.session) attachHidSelector(wc.session);
  });
  app.whenReady().then(() => {
    attachHidSelector(session.defaultSession);
  });

  // Track main BrowserWindow for linux_updater notifications and clean quit
  let primaryWindow = null;
  app.on("browser-window-created", (_ev, win) => {
    if (!primaryWindow || primaryWindow.isDestroyed()) {
      primaryWindow = win;
    }
    win.once("closed", () => {
      if (primaryWindow === win) primaryWindow = null;
    });
  });

  const getMainWindow = () => {
    if (primaryWindow && !primaryWindow.isDestroyed()) return primaryWindow;
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    return wins[0] || null;
  };

  // 3. Resilient external fetch using Electron net.fetch + 30s timeout + retries
  if (typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init = {}) => {
      const urlStr = typeof input === "string" ? input : input?.url || String(input);
      if (!isExternalHttpUrl(urlStr)) {
        return origFetch(input, init);
      }

      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ac = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, 30000);
        try {
          const fn =
            app.isReady() && net && typeof net.fetch === "function"
              ? net.fetch.bind(net)
              : origFetch;
          const reqInit = { ...init, signal: ac.signal };
          return await fn(urlStr, reqInit);
        } catch (err) {
          lastErr = timedOut ? new Error("timeout of 30000ms exceeded") : err;
          if (attempt === maxAttempts - 1 || !isRetryableFetchError(lastErr)) {
            throw lastErr;
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastErr;
    };
  }

  // 4. Native Linux updater IPC + Windows-only service stubs + IPC error translation
  const rawHandle = ipcMain.handle.bind(ipcMain);
  const rawOn = ipcMain.on.bind(ipcMain);

  registerLinuxUpdater({
    app,
    ipcMain: { handle: rawHandle, on: rawOn },
    net,
    getMainWindow,
    log: (entry) => {
      try {
        console.log(`[linuxUpdater][${entry?.level || "INFO"}]`, entry?.message || entry);
      } catch {}
    },
    onBeforeQuitForUpdate: () => {
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.removeAllListeners("close");
            w.destroy();
          }
        }
      } catch {}
    },
  });

  for (const [channel, stubFn] of HEADSET_STUB_HANDLERS) {
    rawHandle(channel, stubFn);
  }

  ipcMain.handle = (channel, listener) => {
    if (UPDATE_HANDLE_CHANNELS.has(channel) || HEADSET_STUB_HANDLERS.has(channel)) {
      return undefined;
    }
    return rawHandle(channel, async (...args) => {
      try {
        const res = await listener(...args);
        return translateIpcResult(res);
      } catch (err) {
        if (err && typeof err.message === "string") {
          const tr = translateMainText(err.message);
          if (tr !== err.message) err.message = tr;
        }
        throw err;
      }
    });
  };

  ipcMain.on = (channel, listener) => {
    if (UPDATE_ON_CHANNELS.has(channel)) {
      return ipcMain;
    }
    return rawOn(channel, listener);
  };

  // 5. Main-process UI English translation (Menu, Tray, Dialog, Notification, Notice popup)
  if (typeof Menu.buildFromTemplate === "function") {
    const origBuildMenu = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => origBuildMenu(translateMenuTemplate(template));
  }

  if (Tray?.prototype && typeof Tray.prototype.setToolTip === "function") {
    const origSetToolTip = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function setToolTipPatched(tip) {
      return origSetToolTip.call(this, translateMainText(tip));
    };
  }

  for (const dlgMethod of ["showOpenDialog", "showSaveDialog"]) {
    if (typeof dialog[dlgMethod] === "function") {
      const origDlg = dialog[dlgMethod].bind(dialog);
      dialog[dlgMethod] = (...args) => {
        if (args.length >= 2 && args[1] && typeof args[1] === "object") {
          args[1] = translateDialogOptions(args[1]);
        } else if (args.length >= 1 && args[0] && typeof args[0] === "object") {
          args[0] = translateDialogOptions(args[0]);
        }
        return origDlg(...args);
      };
    }
  }

  if (Notification?.prototype && typeof Notification.prototype.show === "function") {
    const origShow = Notification.prototype.show;
    Notification.prototype.show = function showPatched() {
      try {
        if (typeof this.title === "string") this.title = translateMainText(this.title);
        if (typeof this.body === "string") this.body = translateMainText(this.body);
      } catch {}
      return origShow.call(this);
    };
  }

  if (BrowserWindow?.prototype && typeof BrowserWindow.prototype.loadURL === "function") {
    const origLoadURL = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = function loadURLPatched(url, options) {
      if (typeof url === "string" && url.startsWith("data:text/html")) {
        const comma = url.indexOf(",");
        if (comma !== -1) {
          const prefix = url.slice(0, comma + 1);
          const payload = url.slice(comma + 1);
          try {
            const decoded = decodeURIComponent(payload);
            const translated = translateMainText(decoded);
            if (translated !== decoded) {
              url = prefix + encodeURIComponent(translated);
            }
          } catch {}
        }
      }
      return origLoadURL.call(this, url, options);
    };
  }

  // 6. Hook aula:// protocol to serve & auto-inject linux_renderer_shim.js (even across hot-updates)
  if (typeof protocol.handle === "function") {
    const origProtocolHandle = protocol.handle.bind(protocol);
    protocol.handle = (scheme, handler) => {
      if (scheme !== "aula") {
        return origProtocolHandle(scheme, handler);
      }
      return origProtocolHandle(scheme, async (request) => {
        try {
          const parsed = new URL(request.url);
          if (
            parsed.hostname === "__linux_shim__" &&
            parsed.pathname === "/renderer_shim.js"
          ) {
            const js = fs.existsSync(RENDERER_SHIM_PATH)
              ? fs.readFileSync(RENDERER_SHIM_PATH, "utf8")
              : "";
            return new Response(js, {
              status: 200,
              headers: { "Content-Type": "application/javascript; charset=utf-8" },
            });
          }
        } catch {}

        const resp = await handler(request);
        try {
          const parsed = new URL(request.url);
          const ct = (resp?.headers?.get("content-type") || "").toLowerCase();
          if (
            resp &&
            resp.ok &&
            (parsed.pathname.endsWith("/index.html") ||
              parsed.pathname === "/index.html" ||
              ct.includes("text/html"))
          ) {
            const html = await resp.text();
            const patched = injectRendererShimHtml(html);
            const headers = new Headers(resp.headers);
            headers.delete("content-length");
            return new Response(patched, {
              status: resp.status,
              statusText: resp.statusText,
              headers,
            });
          }
        } catch {}
        return resp;
      });
    };
  }
}
