/**
 * Native Linux auto-updater implementing AULA HUB's update:* IPC contract.
 * Downloads official AULA Windows installers over a single resilient, resumable
 * HTTP/1.1 stream, verifies SHA-512, and invokes apply_update.py to unpack,
 * re-patch for Linux + English, and relaunch.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const _rawBaseUrl = (
  process.env.AULA_UPDATE_BASE_URL ||
  "https://toolsuse.aulacn.com/zip-use/ClientBase/"
).trim();
const UPDATE_BASE_URL = _rawBaseUrl.endsWith("/")
  ? _rawBaseUrl
  : `${_rawBaseUrl}/`;
const LATEST_YML_URL = `${UPDATE_BASE_URL}latest.yml`;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const MAX_STREAM_RETRIES = 30;
const CONNECT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 60000;

const http1Agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const https1Agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function makeAbortError(message = "Operation aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

function isAbortError(err, signal) {
  return Boolean(
    (signal && signal.aborted) ||
      (err && (err.name === "AbortError" || err.code === "ABORT_ERR"))
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestHttp1(urlStr, options = {}, redirectCount = 0) {
  const {
    method = "GET",
    headers = {},
    signal = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxRedirects = 5,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = parsed.protocol === "http:" ? http : https;
    let settled = false;
    let req = null;

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      const abortErr = makeAbortError();
      if (req) {
        try {
          req.destroy(abortErr);
        } catch {}
      }
      fail(abortErr);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req = transport.request(
      parsed,
      {
        method,
        family: 4,
        agent: parsed.protocol === "http:" ? http1Agent : https1Agent,
        headers: {
          "User-Agent": "electron-updater",
          ...headers,
        },
      },
      (res) => {
        req.setTimeout(timeoutMs);
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          loc &&
          redirectCount < maxRedirects
        ) {
          res.resume();
          cleanup();
          settled = true;
          const nextUrl = new URL(loc, urlStr).toString();
          const nextMethod = status === 303 && method !== "HEAD" ? "GET" : method;
          requestHttp1(
            nextUrl,
            { method: nextMethod, headers, signal, timeoutMs, maxRedirects },
            redirectCount + 1
          ).then(resolve, reject);
          return;
        }

        if (signal && signal.aborted) {
          res.destroy(makeAbortError());
          fail(makeAbortError());
          return;
        }

        const onSignalAbortStream = () => {
          const abortErr = makeAbortError();
          try {
            res.destroy(abortErr);
          } catch {}
          try {
            req.destroy(abortErr);
          } catch {}
        };

        if (signal) {
          signal.removeEventListener("abort", onAbort);
          signal.addEventListener("abort", onSignalAbortStream, { once: true });
          const detachStreamListener = () => {
            signal.removeEventListener("abort", onSignalAbortStream);
          };
          res.once("end", detachStreamListener);
          res.once("close", detachStreamListener);
          res.once("error", detachStreamListener);
        }

        settled = true;
        resolve({ res, req, finalUrl: urlStr });
      }
    );

    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      const err = new Error(`HTTP/1.1 timeout after ${CONNECT_TIMEOUT_MS}/${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });

    req.on("error", fail);
    req.end();
  });
}

async function computeFileSha512Base64(filePath, signal) {
  const hash = crypto.createHash("sha512");
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) {
        throw makeAbortError();
      }
      hash.update(chunk);
    }
    return hash.digest("base64");
  } finally {
    stream.destroy();
  }
}

function parseLatestYml(ymlText) {
  const info = {};
  for (const rawLine of ymlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "size") {
      const n = Number(val);
      if (Number.isFinite(n)) info.size = n;
    } else if (["version", "path", "sha512", "releaseDate"].includes(key)) {
      info[key] = val;
    }
  }
  return info;
}

function compareSemver(a, b) {
  const pa = String(a || "0")
    .split(/[-+]/)[0]
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0")
    .split(/[-+]/)[0]
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

export function registerLinuxUpdater({
  app,
  ipcMain,
  net: _net,
  getMainWindow,
  log,
  onBeforeQuitForUpdate,
}) {
  let cachedInfo = null;
  let downloadedInstallerPath = null;
  let activeAbort = null;
  let activePartialPath = null;
  let cancelledByUser = false;

  const send = (channel, ...args) => {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    } catch {
      // Ignore send failure when window is closing
    }
  };

  const writeLog = (level, type, message, extra = {}) => {
    try {
      if (typeof log === "function") {
        log({ level, origin: "MAIN", type, message, ...extra });
      }
    } catch {
      // Ignore log failures
    }
  };

  const fetchLatestInfo = async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ac = new AbortController();
      try {
        const { res } = await requestHttp1(LATEST_YML_URL, {
          method: "GET",
          headers: { "Cache-Control": "no-cache" },
          signal: ac.signal,
          timeoutMs: 30000,
        });
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          res.resume();
          throw new Error(`Failed to fetch latest.yml: HTTP ${status}`);
        }
        const chunks = [];
        for await (const chunk of res) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const info = parseLatestYml(text);
        if (!info.version || !info.path) {
          throw new Error("Invalid latest.yml payload");
        }
        cachedInfo = info;
        return info;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await sleep(400 * (attempt + 1));
        }
      }
    }
    throw lastErr;
  };

  const downloadResumableStream = async (
    urlStr,
    destPath,
    expectedTotalBytes,
    etag,
    signal,
    setBytesProgress
  ) => {
    let received = 0;

    if (fs.existsSync(destPath)) {
      try {
        const st = fs.statSync(destPath);
        if (expectedTotalBytes > 0 && st.size > expectedTotalBytes) {
          fs.unlinkSync(destPath);
        } else if (st.size > 0) {
          received = st.size;
          setBytesProgress(received);
          if (expectedTotalBytes > 0 && received === expectedTotalBytes) {
            return;
          }
        }
      } catch {}
    }

    let attempt = 0;
    while (true) {
      let fh = null;
      try {
        if (signal.aborted) throw makeAbortError();

        const headers = { "Accept-Encoding": "identity" };
        if (received > 0) {
          headers.Range = `bytes=${received}-`;
          if (etag) headers["If-Range"] = etag;
        }

        const { res } = await requestHttp1(urlStr, {
          method: "GET",
          headers,
          signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });

        const status = res.statusCode || 0;
        if (!etag && res.headers.etag) {
          etag = String(res.headers.etag);
        }
        if (status === 416 && received > 0) {
          res.resume();
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {}
          received = 0;
          setBytesProgress(0);
          continue;
        }

        if (status === 200) {
          if (received > 0) {
            received = 0;
            setBytesProgress(0);
          }
          fh = await fs.promises.open(destPath, "w");
        } else if (status === 206 && received > 0) {
          fh = await fs.promises.open(destPath, "r+");
        } else {
          res.resume();
          throw new Error(`Download failed: HTTP ${status}`);
        }

        for await (const rawChunk of res) {
          if (signal.aborted) throw makeAbortError();
          const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          await fh.write(buf, 0, buf.length, received);
          received += buf.length;
          setBytesProgress(received);
        }

        await fh.close();
        fh = null;

        const targetLen = expectedTotalBytes || Number(res.headers["content-length"]) || 0;
        if (targetLen > 0 && received < targetLen) {
          throw new Error(
            `Incomplete stream: ${received}/${targetLen} bytes`
          );
        }
        return;
      } catch (err) {
        if (fh) {
          try {
            await fh.close();
          } catch {}
        }
        if (isAbortError(err, signal) || attempt >= MAX_STREAM_RETRIES) {
          throw err;
        }
        attempt += 1;
        writeLog(
          "WARN",
          "UPDATE",
          `[linuxUpdater] Stream retry ${attempt}/${MAX_STREAM_RETRIES} at byte ${received}: ${err.message || err}`
        );
        await sleep(Math.min(10000, 2500 * attempt), signal);
      }
    }
  };

  ipcMain.handle("update:check", async () => {
    try {
      const info = await fetchLatestInfo();
      const currentVer = app.getVersion();
      if (compareSemver(info.version, currentVer) > 0) {
        writeLog(
          "INFO",
          "UPDATE_EVENT",
          `Linux updater found new version: ${info.version}`
        );
      } else {
        send("update-not-available");
      }
      return info;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      send("error", msg);
      writeLog("ERROR", "UPDATE_ERROR", `[linuxUpdater] check failed: ${msg}`);
      return null;
    }
  });

  ipcMain.handle("update:download", async () => {
    if (activeAbort) {
      throw new Error("Update download already in progress");
    }
    const ac = new AbortController();
    activeAbort = ac;
    cancelledByUser = false;

    try {
      const info = cachedInfo || (await fetchLatestInfo());
      const safeVer = String(info.version).replace(/[^a-zA-Z0-9._-]/g, "_");
      const cacheDir = path.resolve(
        process.env.AULA_UPDATE_CACHE_DIR || os.tmpdir()
      );
      fs.mkdirSync(cacheDir, { recursive: true });
      const targetExe = path.join(cacheDir, `aula-hub-update-${safeVer}.exe`);
      activePartialPath = `${targetExe}.part`;
      downloadedInstallerPath = null;

      // Fast path: reuse verified installer already downloaded in /tmp
      if (fs.existsSync(targetExe)) {
        try {
          const st = fs.statSync(targetExe);
          const expectedSize = Number(info.size) || 0;
          if (!expectedSize || st.size === expectedSize) {
            send("update-phase", "verifying");
            const cachedDigest = await computeFileSha512Base64(
              targetExe,
              ac.signal
            );
            if (!info.sha512 || cachedDigest === info.sha512) {
              downloadedInstallerPath = targetExe;
              send("update-progress", 100);
              send("update-downloaded");
              writeLog(
                "INFO",
                "UPDATE",
                `[linuxUpdater] Reused verified installer: ${targetExe}`
              );
              return targetExe;
            }
          }
          fs.unlinkSync(targetExe);
        } catch (cacheErr) {
          if (isAbortError(cacheErr, ac.signal)) throw cacheErr;
          try {
            if (fs.existsSync(targetExe)) fs.unlinkSync(targetExe);
          } catch {}
        }
      }

      send("update-phase", "downloading");
      send("update-progress", 0);

      const url = new URL(encodeURI(info.path), UPDATE_BASE_URL).toString();
      writeLog(
        "INFO",
        "UPDATE",
        `[linuxUpdater] Downloading ${url} via resumable HTTP/1.1`
      );

      const totalBytes = Number(info.size) || 0;

      let lastPct = -1;
      const setBytesProgress = (receivedBytes) => {
        if (totalBytes > 0) {
          const pct = Math.min(
            99,
            Math.floor((Math.max(0, receivedBytes) * 100) / totalBytes)
          );
          if (pct !== lastPct) {
            lastPct = pct;
            send("update-progress", pct);
          }
        }
      };

      await downloadResumableStream(
        url,
        activePartialPath,
        totalBytes,
        "",
        ac.signal,
        setBytesProgress
      );

      if (ac.signal.aborted) {
        throw makeAbortError();
      }

      send("update-phase", "verifying");
      const digest = await computeFileSha512Base64(
        activePartialPath,
        ac.signal
      );
      if (info.sha512 && digest !== info.sha512) {
        try {
          if (fs.existsSync(activePartialPath)) fs.unlinkSync(activePartialPath);
        } catch {}
        throw new Error("SHA-512 verification failed for downloaded installer");
      }

      fs.renameSync(activePartialPath, targetExe);
      activePartialPath = null;
      downloadedInstallerPath = targetExe;

      send("update-progress", 100);
      send("update-downloaded");
      writeLog(
        "INFO",
        "UPDATE",
        `[linuxUpdater] Verified & ready: ${targetExe}`
      );
      return targetExe;
    } catch (err) {
      if (cancelledByUser || isAbortError(err, ac.signal)) {
        try {
          if (activePartialPath && fs.existsSync(activePartialPath)) {
            fs.unlinkSync(activePartialPath);
          }
        } catch {}
        activePartialPath = null;
      }
      const msg = (err && err.message) || String(err);
      send("error", msg);
      writeLog("ERROR", "UPDATE_ERROR", `[linuxUpdater] download failed: ${msg}`);
      throw err;
    } finally {
      activeAbort = null;
    }
  });

  ipcMain.handle("update:cancel-download", async () => {
    cancelledByUser = true;
    if (activeAbort) {
      try {
        activeAbort.abort();
      } catch {}
    }
    if (activePartialPath && !activeAbort) {
      try {
        if (fs.existsSync(activePartialPath)) fs.unlinkSync(activePartialPath);
      } catch {}
      activePartialPath = null;
    }
    writeLog("INFO", "UPDATE", "[linuxUpdater] Download cancelled");
  });

  ipcMain.on("update:quit-and-install", () => {
    if (!downloadedInstallerPath || !fs.existsSync(downloadedInstallerPath)) {
      const msg = "No verified update installer found to apply";
      send("error", msg);
      writeLog("ERROR", "UPDATE_ERROR", `[linuxUpdater] ${msg}`);
      return;
    }
    const applyScript = path.join(ROOT_DIR, "apply_update.py");
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const updaterLog = path.join(logDir, "linux_updater.log");
    const logFd = fs.openSync(updaterLog, "a");

    writeLog(
      "INFO",
      "UPDATE",
      `[linuxUpdater] Spawning apply_update.py for ${downloadedInstallerPath}`
    );

    if (typeof onBeforeQuitForUpdate === "function") {
      onBeforeQuitForUpdate();
    }

    const child = spawn(
      "python3",
      [
        applyScript,
        downloadedInstallerPath,
        "--wait-pid",
        String(process.pid),
        "--relaunch",
      ],
      {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      }
    );
    child.unref();
    try {
      fs.closeSync(logFd);
    } catch {}
    app.quit();
  });
}
