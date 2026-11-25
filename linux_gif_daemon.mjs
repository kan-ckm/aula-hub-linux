#!/usr/bin/env node
/**
 * Lightweight headless GIF RGB LED daemon & CLI for AULA HUB on Linux.
 *
 * Streams per-key RGB GIF frames directly to /dev/hidraw* at ~20 MB RAM and
 * <0.5% CPU — replacing the ~900 MB Electron UI when running GIF LED in the
 * background or on login via systemd --user.
 *
 * Supports:
 *  - Automatic background handoff when AULA HUB GUI exits while Live GIF is active
 *  - Direct CLI playback of any .gif file (zero external dependencies)
 *  - Clean auto-stop when AULA HUB GUI opens, and auto-reconnect on USB replug
 *  - Hardware-verified RLW protocol (WIN 68 HE / WIN 60 HE, 0x2e3c:0xc365)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);

// RLW 6x22 = 132-LED matrix protocol (WIN 68 HE / WIN 60 HE, VID 0x2e3c PID 0xc365)
export const RLW_VID = 0x2e3c;
export const RLW_PID = 0xc365;
export const RLW_USAGE_PAGE = 0xff1b;
export const RLW_USAGE = 0x91;
export const RLW_REPORT_ID = 0x01;
export const RLW_PACKET_SIZE = 63;
const RLW_ROWS = 6;
const RLW_COLS = 22;
const RLW_LED_COUNT = RLW_ROWS * RLW_COLS; // 132
const RLW_LEDS_PER_PACKET = 18;
const RLW_CHUNKS_PER_FRAME = Math.ceil(RLW_LED_COUNT / RLW_LEDS_PER_PACKET); // 8

// Key layouts: [x, y, width, height, ledIndex]
const WIN68_LAYOUT = [
  [47, 20, 50, 50, 22], [102, 20, 50, 50, 23], [157, 20, 50, 50, 24], [212, 20, 50, 50, 25],
  [267, 20, 50, 50, 26], [322, 20, 50, 50, 27], [377, 20, 50, 50, 28], [432, 20, 50, 50, 29],
  [487, 20, 50, 50, 30], [542, 20, 50, 50, 31], [597, 20, 50, 50, 32], [652, 20, 50, 50, 33],
  [707, 20, 50, 50, 34], [762, 20, 113, 50, 36], [880, 20, 50, 50, 38],
  [47, 75, 78, 50, 44], [130, 75, 50, 50, 45], [187, 75, 50, 50, 46], [240, 75, 50, 50, 47],
  [295, 75, 50, 50, 48], [350, 75, 50, 50, 49], [405, 75, 50, 50, 50], [460, 75, 50, 50, 51],
  [515, 75, 50, 50, 52], [570, 75, 50, 50, 53], [625, 75, 50, 50, 54], [680, 75, 50, 50, 55],
  [735, 75, 50, 50, 56], [790, 75, 85, 50, 58], [880, 75, 50, 50, 60],
  [47, 130, 97, 50, 66], [149, 130, 50, 50, 68], [204, 130, 50, 50, 69], [259, 130, 50, 50, 70],
  [314, 130, 50, 50, 71], [369, 130, 50, 50, 72], [424, 130, 50, 50, 73], [479, 130, 50, 50, 74],
  [534, 130, 50, 50, 75], [589, 130, 50, 50, 76], [644, 130, 50, 50, 77], [699, 130, 50, 50, 78],
  [754, 130, 121, 50, 80], [880, 130, 50, 50, 82],
  [47, 185, 120, 50, 88], [172, 185, 50, 50, 90], [227, 185, 50, 50, 91], [282, 185, 50, 50, 92],
  [337, 185, 50, 50, 93], [392, 185, 50, 50, 94], [447, 185, 50, 50, 95], [502, 185, 50, 50, 96],
  [557, 185, 50, 50, 97], [612, 185, 50, 50, 98], [667, 185, 50, 50, 99], [722, 185, 98, 50, 101],
  [825, 185, 50, 50, 103], [880, 185, 50, 50, 104],
  [47, 240, 75, 50, 110], [127, 240, 75, 50, 111], [207, 240, 75, 50, 112],
  [287, 240, 313, 50, 116], [605, 240, 50, 50, 119], [660, 240, 50, 50, 121],
  [715, 240, 50, 50, 122], [770, 240, 50, 50, 124], [825, 240, 50, 50, 125], [880, 240, 50, 50, 126],
];

const WIN60_LAYOUT = [
  [42, 20, 50, 50, 22], [97, 20, 50, 50, 23], [152, 20, 50, 50, 24], [207, 20, 50, 50, 25],
  [262, 20, 50, 50, 26], [317, 20, 50, 50, 27], [372, 20, 50, 50, 28], [427, 20, 50, 50, 29],
  [482, 20, 50, 50, 30], [537, 20, 50, 50, 31], [592, 20, 50, 50, 32], [647, 20, 50, 50, 33],
  [702, 20, 50, 50, 34], [757, 20, 113, 50, 36],
  [42, 75, 78, 50, 44], [125, 75, 50, 50, 45], [182, 75, 50, 50, 46], [235, 75, 50, 50, 47],
  [290, 75, 50, 50, 48], [345, 75, 50, 50, 49], [400, 75, 50, 50, 50], [455, 75, 50, 50, 51],
  [510, 75, 50, 50, 52], [565, 75, 50, 50, 53], [620, 75, 50, 50, 54], [675, 75, 50, 50, 55],
  [730, 75, 50, 50, 56], [785, 75, 85, 50, 58],
  [42, 130, 97, 50, 66], [144, 130, 50, 50, 68], [199, 130, 50, 50, 69], [254, 130, 50, 50, 70],
  [309, 130, 50, 50, 71], [364, 130, 50, 50, 72], [419, 130, 50, 50, 73], [474, 130, 50, 50, 74],
  [529, 130, 50, 50, 75], [584, 130, 50, 50, 76], [639, 130, 50, 50, 77], [694, 130, 50, 50, 78],
  [749, 130, 121, 50, 80],
  [42, 185, 120, 50, 88], [167, 185, 50, 50, 90], [222, 185, 50, 50, 91], [277, 185, 50, 50, 92],
  [332, 185, 50, 50, 93], [387, 185, 50, 50, 94], [442, 185, 50, 50, 95], [497, 185, 50, 50, 96],
  [552, 185, 50, 50, 97], [607, 185, 50, 50, 98], [662, 185, 50, 50, 99], [717, 185, 153, 50, 100],
  [42, 240, 68.57, 50, 110], [115.57, 240, 68.57, 50, 111], [189.14, 240, 68.57, 50, 112],
  [262.71, 240, 313, 50, 116], [580.71, 240, 68.57, 50, 119], [654.29, 240, 68.57, 50, 120],
  [727.86, 240, 68.57, 50, 121], [801.43, 240, 68.57, 50, 122],
];

export function getConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "aula-hub");
}

export function getCachePath() {
  return path.join(getConfigDir(), "live-gif-cache.json");
}

export function getPidFilePath() {
  const rt = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(rt, "aula-gifd.pid");
}

export function getSystemdUnitPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user", "aula-gifd.service");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOurDaemonPid(pid) {
  if (!isPidAlive(pid)) return false;
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (comm === "aula-gifd") return true;
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return cmd.includes("linux_gif_daemon.mjs") || cmd.includes("aula-gifd");
  } catch {
    return false;
  }
}

export function getDaemonState() {
  const pidPath = getPidFilePath();
  if (!fs.existsSync(pidPath)) return null;
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const info = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
    if (info && isOurDaemonPid(Number(info.pid))) {
      let rssKb = null;
      try {
        const status = fs.readFileSync(`/proc/${info.pid}/status`, "utf8");
        const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (m) rssKb = Number(m[1]);
      } catch {}
      return { ...info, pid: Number(info.pid), rssKb };
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {}
  } catch {}
  return null;
}

export function stopDaemon({ signal = "SIGTERM", waitMs = 600 } = {}) {
  const state = getDaemonState();
  if (!state) return false;
  try {
    process.kill(state.pid, signal);
  } catch {
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isOurDaemonPid(state.pid)) {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, 20);
  }
  if (isOurDaemonPid(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {}
  }
  try {
    fs.unlinkSync(getPidFilePath());
  } catch {}
  return true;
}

export function saveGifCache(cacheObj, cachePath = getCachePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cacheObj), "utf8");
  fs.renameSync(tmp, cachePath);
  return cachePath;
}

export function loadGifCache(cachePath = getCachePath()) {
  if (!fs.existsSync(cachePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) return null;
  return parsed;
}

function resolveNodeBinary() {
  if (process.env.AULA_HUB_NODE) return process.env.AULA_HUB_NODE;
  if (process.versions && process.versions.electron) {
    return "node";
  }
  return process.execPath || "node";
}

export function startDaemonDetached({ delayMs = 0, cachePath = getCachePath(), daemonScript = THIS_FILE } = {}) {
  stopDaemon({ signal: "SIGTERM", waitMs: 400 });
  const args = [daemonScript, "run", "--cache", cachePath];
  if (delayMs > 0) args.push("--delay-ms", String(Math.round(delayMs)));
  const child = spawn(resolveNodeBinary(), args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------------------
// HID Report Descriptor UsagePage / Usage parser & /dev/hidraw discovery
// ---------------------------------------------------------------------------

export function parseReportDescriptorUsages(buf) {
  const pairs = [];
  let usagePage = null;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0xfe) {
      // Long item: 0xFE, dataSize, longTag, ...data
      const len = i + 1 < buf.length ? buf[i + 1] : 0;
      i += 3 + len;
      continue;
    }
    const sizeCode = b & 0x03;
    const size = sizeCode === 3 ? 4 : sizeCode;
    const type = (b >> 2) & 0x03; // 0=Main, 1=Global, 2=Local
    const tag = (b >> 4) & 0x0f;
    let val = 0;
    for (let k = 0; k < size && i + 1 + k < buf.length; k++) {
      val |= buf[i + 1 + k] << (8 * k);
    }
    if (type === 1 && tag === 0x00) {
      usagePage = val >>> 0;
    } else if (type === 2 && tag === 0x00 && usagePage !== null) {
      pairs.push({ usagePage, usage: val >>> 0 });
    }
    i += 1 + size;
  }
  return pairs;
}

export function findHidrawDevice({
  vid = RLW_VID,
  pid = RLW_PID,
  usagePage = RLW_USAGE_PAGE,
  usage = RLW_USAGE,
  sysClassDir = "/sys/class/hidraw",
} = {}) {
  if (!fs.existsSync(sysClassDir)) return null;
  const entries = fs.readdirSync(sysClassDir).sort();
  let fallbackMatch = null;
  for (const name of entries) {
    const devSysDir = path.join(sysClassDir, name, "device");
    const ueventPath = path.join(devSysDir, "uevent");
    if (!fs.existsSync(ueventPath)) continue;
    let uevent = "";
    try {
      uevent = fs.readFileSync(ueventPath, "utf8");
    } catch {
      continue;
    }
    const idMatch = uevent.match(/^HID_ID=[0-9A-Fa-f]+:([0-9A-Fa-f]+):([0-9A-Fa-f]+)$/m);
    if (!idMatch) continue;
    const devVid = parseInt(idMatch[1], 16);
    const devPid = parseInt(idMatch[2], 16);
    if (devVid !== vid || devPid !== pid) continue;

    const nameMatch = uevent.match(/^HID_NAME=(.*)$/m);
    const hidName = nameMatch ? nameMatch[1].trim() : "";
    const devPath = `/dev/${name}`;

    const rdescPath = path.join(devSysDir, "report_descriptor");
    if (fs.existsSync(rdescPath)) {
      try {
        const rdesc = fs.readFileSync(rdescPath);
        const pairs = parseReportDescriptorUsages(rdesc);
        if (pairs.some((p) => p.usagePage === usagePage && (usage == null || p.usage === usage))) {
          return { devPath, hidName, vid: devVid, pid: devPid, usagePage, usage };
        }
        if (
          !fallbackMatch &&
          pairs.some((p) => p.usagePage >= 0xff00)
        ) {
          fallbackMatch = { devPath, hidName, vid: devVid, pid: devPid, usagePage, usage };
        }
      } catch {}
    }
  }
  return fallbackMatch;
}

// ---------------------------------------------------------------------------
// Pure-JS GIF87a / GIF89a Decoder (zero external dependencies)
// ---------------------------------------------------------------------------

function lzwDecode(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  const out = new Uint8Array(pixelCount);
  let outPos = 0;

  let bitBuf = 0;
  let bitCount = 0;
  let dataPos = 0;

  const readCode = () => {
    while (bitCount < codeSize) {
      if (dataPos >= data.length) return eoiCode;
      bitBuf |= data[dataPos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  let prevCode = -1;
  let firstChar = 0;

  while (outPos < pixelCount) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      prevCode = -1;
      continue;
    }
    if (prevCode === -1) {
      if (code < clearCode) {
        out[outPos++] = code;
        firstChar = code;
        prevCode = code;
      }
      continue;
    }

    let inCode = code;
    let stackPos = 0;
    if (code >= nextCode) {
      if (code > nextCode) break;
      stack[stackPos++] = firstChar;
      inCode = prevCode;
    }
    while (inCode >= clearCode && stackPos < 4096) {
      stack[stackPos++] = suffix[inCode];
      inCode = prefix[inCode];
    }
    firstChar = inCode & 0xff;
    stack[stackPos++] = firstChar;

    while (stackPos > 0 && outPos < pixelCount) {
      out[outPos++] = stack[--stackPos];
    }

    if (nextCode < 4096) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = firstChar;
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
    }
    prevCode = code;
  }
  return out;
}

export function decodeGif(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 13) throw new Error("Invalid GIF: file too short");
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") {
    throw new Error(`Invalid GIF header: ${sig}`);
  }

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 1 << ((packed & 0x07) + 1) : 0;

  let pos = 13;
  let gct = null;
  if (hasGct) {
    gct = buf.subarray(pos, pos + gctSize * 3);
    pos += gctSize * 3;
  }

  const canvas = new Uint8Array(width * height * 4);
  const prevCanvas = new Uint8Array(width * height * 4);
  const frames = [];

  let gce = { delayMs: 100, disposal: 0, transparentIndex: -1 };

  const readSubBlocks = () => {
    const chunks = [];
    let total = 0;
    while (pos < buf.length) {
      const len = buf[pos++];
      if (len === 0) break;
      const slice = buf.subarray(pos, Math.min(pos + len, buf.length));
      chunks.push(slice);
      total += slice.length;
      pos += len;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return merged;
  };

  while (pos < buf.length) {
    const intro = buf[pos++];
    if (intro === 0x3b) break; // Trailer

    if (intro === 0x21) {
      // Extension block
      const label = buf[pos++];
      if (label === 0xf9 && pos + 5 <= buf.length) {
        const blockSize = buf[pos++];
        const flags = buf[pos];
        const delayCs = buf.readUInt16LE(pos + 1);
        const transpIdx = buf[pos + 3];
        const hasTransp = (flags & 0x01) !== 0;
        const disposal = (flags >> 2) & 0x07;
        gce = {
          delayMs: delayCs > 0 ? delayCs * 10 : 100,
          disposal,
          transparentIndex: hasTransp ? transpIdx : -1,
        };
        pos += blockSize;
        if (buf[pos] === 0) pos++;
      } else {
        readSubBlocks();
      }
      continue;
    }

    if (intro === 0x2c) {
      // Image descriptor
      if (pos + 9 > buf.length) break;
      const left = buf.readUInt16LE(pos);
      const top = buf.readUInt16LE(pos + 2);
      const imgW = buf.readUInt16LE(pos + 4);
      const imgH = buf.readUInt16LE(pos + 6);
      const imgPacked = buf[pos + 8];
      pos += 9;

      const hasLct = (imgPacked & 0x80) !== 0;
      const interlaced = (imgPacked & 0x40) !== 0;
      const lctSize = hasLct ? 1 << ((imgPacked & 0x07) + 1) : 0;

      let ct = gct;
      if (hasLct) {
        ct = buf.subarray(pos, pos + lctSize * 3);
        pos += lctSize * 3;
      }

      const minCodeSize = buf[pos++];
      const lzwData = readSubBlocks();
      const pixels = lzwDecode(minCodeSize, lzwData, imgW * imgH);

      if (gce.disposal === 3) {
        prevCanvas.set(canvas);
      }

      // Draw frame patch onto canvas
      const passStarts = [0, 4, 2, 1];
      const passSteps = [8, 8, 4, 2];
      let srcRow = 0;

      const drawRow = (yLocal, srcRowIdx) => {
        const dy = top + yLocal;
        if (dy < 0 || dy >= height) return;
        const rowOff = srcRowIdx * imgW;
        for (let xLocal = 0; xLocal < imgW; xLocal++) {
          const dx = left + xLocal;
          if (dx < 0 || dx >= width) continue;
          const colorIdx = pixels[rowOff + xLocal];
          if (colorIdx === gce.transparentIndex) continue;
          const ci = colorIdx * 3;
          const di = (dy * width + dx) * 4;
          if (ct && ci + 2 < ct.length) {
            canvas[di] = ct[ci];
            canvas[di + 1] = ct[ci + 1];
            canvas[di + 2] = ct[ci + 2];
            canvas[di + 3] = 255;
          }
        }
      };

      if (interlaced) {
        for (let p = 0; p < 4; p++) {
          for (let y = passStarts[p]; y < imgH; y += passSteps[p]) {
            drawRow(y, srcRow++);
          }
        }
      } else {
        for (let y = 0; y < imgH; y++) {
          drawRow(y, y);
        }
      }

      frames.push({
        rgba: new Uint8Array(canvas),
        delayMs: gce.delayMs,
      });

      // Apply disposal for next frame
      if (gce.disposal === 2) {
        for (let y = 0; y < imgH; y++) {
          const dy = top + y;
          if (dy < 0 || dy >= height) continue;
          for (let x = 0; x < imgW; x++) {
            const dx = left + x;
            if (dx < 0 || dx >= width) continue;
            const di = (dy * width + dx) * 4;
            canvas[di] = 0;
            canvas[di + 1] = 0;
            canvas[di + 2] = 0;
            canvas[di + 3] = 0;
          }
        }
      } else if (gce.disposal === 3) {
        canvas.set(prevCanvas);
      }

      gce = { delayMs: 100, disposal: 0, transparentIndex: -1 };
      continue;
    }
  }

  if (!frames.length) throw new Error("GIF contains no decodable frames");
  return { width, height, frames };
}

// ---------------------------------------------------------------------------
// RLW Matrix Builder & Color Grading for Physical Per-Key RGB LEDs
// ---------------------------------------------------------------------------

function buildRlwSourceMap(layout) {
  const indexToKey = new Map();
  layout.forEach((entry, keyPos) => {
    const ledIdx = entry[4];
    if (ledIdx >= 0 && ledIdx < RLW_LED_COUNT) {
      indexToKey.set(ledIdx, keyPos);
    }
  });

  const sources = new Int32Array(RLW_LED_COUNT).fill(-1);
  for (let row = 0; row < RLW_ROWS; row++) {
    const rowIndices = [];
    for (const idx of indexToKey.keys()) {
      if (Math.floor(idx / RLW_COLS) === row) rowIndices.push(idx);
    }
    for (let col = 0; col < RLW_COLS; col++) {
      const ledIdx = row * RLW_COLS + col;
      if (indexToKey.has(ledIdx)) {
        sources[ledIdx] = indexToKey.get(ledIdx);
        continue;
      }
      if (!rowIndices.length) continue;
      let best = rowIndices[0];
      let bestDist = Math.abs((best % RLW_COLS) - col);
      for (let i = 1; i < rowIndices.length; i++) {
        const dist = Math.abs((rowIndices[i] % RLW_COLS) - col);
        if (dist < bestDist) {
          bestDist = dist;
          best = rowIndices[i];
        }
      }
      sources[ledIdx] = indexToKey.get(best);
    }
  }
  return sources;
}

export function buildRlwSyncPacket(enable) {
  const pkt = Buffer.alloc(RLW_PACKET_SIZE);
  pkt[0] = 0x17;
  pkt[4] = 0x02;
  pkt[5] = enable ? 0x01 : 0x00;
  pkt[6] = enable ? 0x01 : 0x00;
  return pkt;
}

export function buildRlwFramePackets(ledColorsRgb) {
  const packets = [];
  for (let chunk = 0; chunk < RLW_CHUNKS_PER_FRAME; chunk++) {
    const pkt = Buffer.alloc(RLW_PACKET_SIZE);
    pkt[0] = 0x0f;
    pkt[2] = (chunk >> 8) & 0xff;
    pkt[3] = chunk & 0xff;
    const startLed = chunk * RLW_LEDS_PER_PACKET;
    const endLed = Math.min(startLed + RLW_LEDS_PER_PACKET, RLW_LED_COUNT);
    let offset = 5;
    for (let led = startLed; led < endLed; led++) {
      const ci = led * 3;
      pkt[offset++] = ledColorsRgb[ci] || 0;
      pkt[offset++] = ledColorsRgb[ci + 1] || 0;
      pkt[offset++] = ledColorsRgb[ci + 2] || 0;
    }
    pkt[4] = offset - 5;
    packets.push(pkt);
  }
  return packets;
}

function gradeLedPixel(r, g, b) {
  // Crush muddy near-black noise and boost saturation so colors pop on SMD RGB LEDs
  let rf = Math.max(0, (r / 255 - 0.05) / 0.95) ** 1.18;
  let gf = Math.max(0, (g / 255 - 0.05) / 0.95) ** 1.18;
  let bf = Math.max(0, (b / 255 - 0.05) / 0.95) ** 1.18;

  const lum = 0.299 * rf + 0.587 * gf + 0.114 * bf;
  const sat = 1.65;
  rf = Math.min(1, Math.max(0, lum + (rf - lum) * sat));
  gf = Math.min(1, Math.max(0, lum + (gf - lum) * sat));
  bf = Math.min(1, Math.max(0, lum + (bf - lum) * sat));
  return [Math.round(rf * 255), Math.round(gf * 255), Math.round(bf * 255)];
}

export function compileGifToCache(
  gifPath,
  { layoutName = "win68", mode = "led", fps = null, speed = null } = {}
) {
  const absPath = path.resolve(gifPath);
  const rawBuf = fs.readFileSync(absPath);
  const { width, height, frames } = decodeGif(rawBuf);

  const layout = layoutName === "win60" ? WIN60_LAYOUT : WIN68_LAYOUT;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, w, h] of layout) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  const layoutW = maxX - minX;
  const layoutH = maxY - minY;
  const targetRatio = layoutW / layoutH; // ~3.27 for win68, ~3.07 for win60

  // Determine source crop rectangle (sx0, sy0, sw, sh)
  let sx0 = 0;
  let sy0 = 0;
  let sw = width;
  let sh = height;
  const srcRatio = width / height;

  if (mode === "crop") {
    if (srcRatio < targetRatio) {
      sh = Math.max(1, Math.round(width / targetRatio));
      sy0 = Math.round((height - sh) / 2);
    } else if (srcRatio > targetRatio) {
      sw = Math.max(1, Math.round(height * targetRatio));
      sx0 = Math.round((width - sw) / 2);
    }
  } else if (mode === "led") {
    // If image is much taller than the keyboard (e.g. 4:3, 1:1, 16:9), trim bottom static band
    if (srcRatio < targetRatio * 0.8) {
      sh = Math.max(1, Math.round(Math.min(height, (width / targetRatio) * 1.65)));
      sy0 = 0;
    }
  }

  const sources = buildRlwSourceMap(layout);
  const encodedFrames = [];
  const delays = [];

  for (const fr of frames) {
    const keyRgb = new Uint8Array(layout.length * 3);
    for (let k = 0; k < layout.length; k++) {
      const [kx, ky, kw, kh] = layout[k];
      const u0 = (kx - minX) / layoutW;
      const v0 = (ky - minY) / layoutH;
      const u1 = (kx - minX + kw) / layoutW;
      const v1 = (ky - minY + kh) / layoutH;

      const xStart = Math.max(0, Math.floor(sx0 + u0 * sw));
      const xEnd = Math.min(width, Math.max(xStart + 1, Math.ceil(sx0 + u1 * sw)));
      const yStart = Math.max(0, Math.floor(sy0 + v0 * sh));
      const yEnd = Math.min(height, Math.max(yStart + 1, Math.ceil(sy0 + v1 * sh)));

      const stepX = Math.max(1, Math.floor((xEnd - xStart) / 10));
      const stepY = Math.max(1, Math.floor((yEnd - yStart) / 10));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let py = yStart; py < yEnd; py += stepY) {
        for (let px = xStart; px < xEnd; px += stepX) {
          const idx = (py * width + px) * 4;
          if (fr.rgba[idx + 3] > 50) {
            let r = fr.rgba[idx];
            let g = fr.rgba[idx + 1];
            let b = fr.rgba[idx + 2];
            if (mode === "led") {
              [r, g, b] = gradeLedPixel(r, g, b);
            }
            sumR += r;
            sumG += g;
            sumB += b;
            count++;
          }
        }
      }

      if (count > 0) {
        keyRgb[k * 3] = Math.round(sumR / count);
        keyRgb[k * 3 + 1] = Math.round(sumG / count);
        keyRgb[k * 3 + 2] = Math.round(sumB / count);
      }
    }

    const ledRgb = new Uint8Array(RLW_LED_COUNT * 3);
    for (let led = 0; led < RLW_LED_COUNT; led++) {
      const srcKey = sources[led];
      if (srcKey >= 0) {
        ledRgb[led * 3] = keyRgb[srcKey * 3];
        ledRgb[led * 3 + 1] = keyRgb[srcKey * 3 + 1];
        ledRgb[led * 3 + 2] = keyRgb[srcKey * 3 + 2];
      }
    }

    const pkts = buildRlwFramePackets(ledRgb).map((b) => b.toString("base64"));
    encodedFrames.push(pkts);
    delays.push(fr.delayMs || 60);
  }

  let frameDelayMs;
  if (fps && fps > 0) {
    frameDelayMs = Math.max(16, Math.round(1000 / fps));
  } else if (speed && speed > 0) {
    frameDelayMs = Math.max(16, Math.round(3000 / speed));
  } else {
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    frameDelayMs = Math.max(20, Math.round(avg));
  }

  return {
    version: 1,
    protocol: "rlw-matrix-132",
    vid: RLW_VID,
    pid: RLW_PID,
    usagePage: RLW_USAGE_PAGE,
    usage: RLW_USAGE,
    reportId: RLW_REPORT_ID,
    packetSize: RLW_PACKET_SIZE,
    chunkDelayMs: 2,
    frameDelayMs,
    syncOn: buildRlwSyncPacket(true).toString("base64"),
    syncOff: buildRlwSyncPacket(false).toString("base64"),
    frames: encodedFrames,
    source: absPath,
    layout: layoutName,
    mode,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Lightweight HID Streaming Loop (~20 MB RAM, <0.5% CPU)
// ---------------------------------------------------------------------------

function makeWireReport(reportId, payloadBuf) {
  const out = Buffer.allocUnsafe(1 + payloadBuf.length);
  out[0] = reportId & 0xff;
  payloadBuf.copy(out, 1);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDaemonLoop({ cachePath = getCachePath(), delayMs = 0 } = {}) {
  try {
    process.title = "aula-gifd";
  } catch {}

  if (delayMs > 0) await sleep(delayMs);

  const cache = loadGifCache(cachePath);
  if (!cache) {
    console.error(`[aula-gifd] No cached GIF found at ${cachePath}`);
    process.exit(1);
  }

  const reportId = cache.reportId ?? RLW_REPORT_ID;
  const syncOnWire = makeWireReport(reportId, Buffer.from(cache.syncOn, "base64"));
  const syncOffWire = makeWireReport(reportId, Buffer.from(cache.syncOff, "base64"));
  const frameWires = cache.frames.map((pkts) =>
    pkts.map((b64) => makeWireReport(reportId, Buffer.from(b64, "base64")))
  );
  const chunkDelayMs = Math.max(1, Number(cache.chunkDelayMs) || 2);
  const frameDelayMs = Math.max(16, Number(cache.frameDelayMs) || 60);

  const pidPath = getPidFilePath();
  fs.writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      source: cache.source || "aula-hub",
      frames: frameWires.length,
      frameDelayMs,
      vid: cache.vid,
      pidHex: `0x${Number(cache.pid).toString(16)}`,
      startedAt: Date.now(),
    }),
    "utf8"
  );

  let running = true;
  let sendSyncOffOnExit = true;
  let fd = null;

  const cleanup = () => {
    if (fd !== null) {
      if (sendSyncOffOnExit) {
        try {
          fs.writeSync(fd, syncOffWire);
        } catch {}
      }
      try {
        fs.closeSync(fd);
      } catch {}
      fd = null;
    }
    try {
      const cur = fs.existsSync(pidPath) ? JSON.parse(fs.readFileSync(pidPath, "utf8")) : null;
      if (!cur || cur.pid === process.pid) fs.unlinkSync(pidPath);
    } catch {}
  };

  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGUSR1", () => {
    // Seamless handoff back to AULA HUB without extra HID write
    sendSyncOffOnExit = false;
    running = false;
  });

  while (running) {
    if (fd === null) {
      const dev = findHidrawDevice({
        vid: cache.vid,
        pid: cache.pid,
        usagePage: cache.usagePage,
        usage: cache.usage,
      });
      if (!dev) {
        await sleep(1500);
        continue;
      }
      try {
        fd = fs.openSync(dev.devPath, "r+");
        fs.writeSync(fd, syncOnWire);
        await sleep(40);
      } catch {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
          fd = null;
        }
        await sleep(1500);
        continue;
      }
    }

    try {
      for (let f = 0; f < frameWires.length && running; f++) {
        const pkts = frameWires[f];
        for (let p = 0; p < pkts.length && running; p++) {
          fs.writeSync(fd, pkts[p]);
          if (chunkDelayMs > 0) await sleep(chunkDelayMs);
        }
        if (running) await sleep(frameDelayMs);
      }
    } catch {
      // Device disconnected or suspended: close fd and poll until replugged
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        fd = null;
      }
      if (running) await sleep(1500);
    }
  }

  cleanup();
}

// ---------------------------------------------------------------------------
// systemd --user Autostart Helper
// ---------------------------------------------------------------------------

function manageAutostart(action) {
  const unitPath = getSystemdUnitPath();
  if (action === "on" || action === "enable") {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const unit = `[Unit]
Description=AULA HUB Lightweight GIF LED Daemon
After=graphical-session.target

[Service]
Type=simple
ExecStart=${resolveNodeBinary()} ${THIS_FILE} run
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(unitPath, unit, "utf8");
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const res = spawnSync("systemctl", ["--user", "enable", "aula-gifd.service"], {
      stdio: "inherit",
    });
    if (res.status === 0) {
      console.log(`Enabled systemd user autostart: ${unitPath}`);
      if (loadGifCache()) {
        console.log("Your cached GIF LED will start automatically on login (~20 MB RAM).");
      } else {
        console.log("Note: Play a GIF once via 'aula-hub gif play <file.gif>' or AULA HUB to populate the cache.");
      }
    }
    return;
  }

  if (action === "off" || action === "disable") {
    spawnSync("systemctl", ["--user", "disable", "--now", "aula-gifd.service"], {
      stdio: "ignore",
    });
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    }
    console.log("Disabled aula-gifd systemd user autostart.");
    return;
  }

  const enabled = spawnSync("systemctl", ["--user", "is-enabled", "aula-gifd.service"], {
    encoding: "utf8",
  });
  console.log(`Autostart: ${(enabled.stdout || "disabled").trim()}`);
}

// ---------------------------------------------------------------------------
// CLI Entrypoint
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`AULA HUB Lightweight GIF LED Daemon (aula-gifd)

Usage:
  aula-hub gif play <file.gif> [options]   Play any GIF directly on keyboard LEDs (~20 MB RAM)
  aula-hub gif resume [--foreground]       Resume last GIF from AULA HUB or CLI cache
  aula-hub gif stop                        Stop background GIF daemon & restore onboard LED
  aula-hub gif status                      Show running daemon PID, RAM, FPS, and cache info
  aula-hub gif autostart <on|off|status>   Enable/disable lightweight login autostart (systemd)

Play options:
  --mode <led|crop|full>     Framing & color mode (default: led)
                               led  - smart crop + vivid RGB LED neon grading
                               crop - strict 1:1 aspect crop, original colors
                               full - full frame fitted to keyboard ratio
  --fps <N>                  Override playback frame rate (e.g. --fps 16)
  --speed <1-100>            AULA HUB speed scale (delay = 3000 / speed ms)
  --layout <auto|win68|win60> Keyboard layout (default: auto-detected from USB HID)
  --foreground               Run in foreground instead of background daemon`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "help";

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    printUsage();
    return;
  }

  if (cmd === "run") {
    let cachePath = getCachePath();
    let delayMs = 0;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--cache" && argv[i + 1]) cachePath = argv[++i];
      else if (argv[i] === "--delay-ms" && argv[i + 1]) delayMs = Number(argv[++i]) || 0;
    }
    await runDaemonLoop({ cachePath, delayMs });
    return;
  }

  if (cmd === "stop") {
    const stopped = stopDaemon({ signal: "SIGTERM", waitMs: 800 });
    if (stopped) {
      console.log("Stopped aula-gifd and restored keyboard onboard lighting.");
    } else {
      console.log("aula-gifd is not running.");
    }
    return;
  }

  if (cmd === "status") {
    const st = getDaemonState();
    const cache = loadGifCache();
    if (st) {
      const mem = st.rssKb ? `${(st.rssKb / 1024).toFixed(1)} MB RAM` : "running";
      const fps = st.frameDelayMs ? (1000 / st.frameDelayMs).toFixed(1) : "?";
      console.log(`aula-gifd: ACTIVE (PID ${st.pid}, ${mem})`);
      console.log(`  Source: ${st.source}`);
      console.log(`  Frames: ${st.frames} @ ~${fps} FPS (${st.frameDelayMs} ms/frame)`);
    } else {
      console.log("aula-gifd: STOPPED");
    }
    if (cache) {
      console.log(`  Cached GIF: ${cache.source} (${cache.frames.length} frames, ${cache.frameDelayMs} ms/frame)`);
    } else {
      console.log("  Cached GIF: none");
    }
    return;
  }

  if (cmd === "autostart") {
    manageAutostart(argv[1] || "status");
    return;
  }

  if (cmd === "resume") {
    const fg = argv.includes("--foreground");
    const cache = loadGifCache();
    if (!cache) {
      console.error("No cached GIF found. Run 'aula-hub gif play <file.gif>' or play a GIF in AULA HUB first.");
      process.exit(1);
    }
    if (fg) {
      stopDaemon({ signal: "SIGTERM", waitMs: 500 });
      await runDaemonLoop({});
    } else {
      const pid = startDaemonDetached({});
      console.log(`Started aula-gifd in background (PID ${pid}) — ${cache.frames.length} frames @ ${cache.frameDelayMs} ms/frame.`);
    }
    return;
  }

  if (cmd === "play") {
    let gifFile = null;
    let mode = "led";
    let fps = null;
    let speed = null;
    let layoutName = "auto";
    let foreground = false;

    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--mode" && argv[i + 1]) mode = argv[++i];
      else if (a === "--fps" && argv[i + 1]) fps = Number(argv[++i]);
      else if (a === "--speed" && argv[i + 1]) speed = Number(argv[++i]);
      else if (a === "--layout" && argv[i + 1]) layoutName = argv[++i];
      else if (a === "--foreground" || a === "-f") foreground = true;
      else if (!a.startsWith("-") && !gifFile) gifFile = a;
      else {
        console.error(`Unknown option: ${a}`);
        process.exit(1);
      }
    }

    if (!gifFile || !fs.existsSync(gifFile)) {
      console.error("Please provide a valid .gif file: aula-hub gif play <file.gif>");
      process.exit(1);
    }

    if (layoutName === "auto") {
      const dev = findHidrawDevice();
      layoutName = dev && /WIN\s*60/i.test(dev.hidName || "") ? "win60" : "win68";
    }

    const cache = compileGifToCache(gifFile, { layoutName, mode, fps, speed });
    saveGifCache(cache);

    if (foreground) {
      stopDaemon({ signal: "SIGTERM", waitMs: 500 });
      console.log(`Playing ${path.basename(gifFile)} (${cache.frames.length} frames, ${layoutName}, mode=${mode}) — Ctrl+C to stop.`);
      await runDaemonLoop({});
    } else {
      const pid = startDaemonDetached({});
      console.log(`Playing ${path.basename(gifFile)} in background via aula-gifd (PID ${pid})`);
      console.log(`  Layout: ${layoutName} | Mode: ${mode} | Frames: ${cache.frames.length} | Delay: ${cache.frameDelayMs} ms`);
      console.log("  Stop anytime with: aula-hub gif stop");
    }
    return;
  }

  console.error(`Unknown gif command: ${cmd}`);
  printUsage();
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  main().catch((err) => {
    console.error("[aula-gifd]", err?.message || err);
    process.exit(1);
  });
}
