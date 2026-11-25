/*__AULA_LINUX_RENDERER_SHIM__*/
/**
 * Runtime renderer shim for AULA HUB on Linux.
 * Runs before the Vite module entry bundle so it works on both obfuscated
 * (1.3.9+) and unobfuscated builds as well as hot-updated bundles:
 *  1. Defaults first-launch language to English ("en") when no preference is saved.
 *  2. Sends the WIN 68 HE / WIN 60 HE (RLW 0x2e3c:0xc365) Host RGB Sync exit packet
 *     on WebHID open so Linux keyboards immediately accept lighting/config commands.
 *  3. Translates remaining hardcoded Chinese toast/dialog/status strings to English
 *     dynamically whenever AULA HUB's active language is "en".
 */
(function initAulaLinuxRendererShim() {
  if (typeof window === "undefined" || window.__AULA_LINUX_RENDERER_SHIM__) return;
  window.__AULA_LINUX_RENDERER_SHIM__ = true;

  // 1. Default language to "en" on first launch (never overrides user's saved choice)
  try {
    const raw = window.localStorage.getItem("aula-store");
    if (!raw) {
      window.localStorage.setItem("aula-store", JSON.stringify({ language: "en" }));
    } else {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !parsed.language) {
        parsed.language = "en";
        window.localStorage.setItem("aula-store", JSON.stringify(parsed));
      }
    }
  } catch {}

  // 2. WIN 68 HE / WIN 60 HE (RuiLianWei 0x2e3c:0xc365) Host RGB Sync exit packet on connect
  try {
    if (
      typeof HIDDevice !== "undefined" &&
      HIDDevice.prototype &&
      typeof HIDDevice.prototype.open === "function" &&
      !HIDDevice.prototype.open.__aulaRlwWrapped
    ) {
      const origOpen = HIDDevice.prototype.open;
      const wrappedOpen = async function openWithRlwSyncOff() {
        const res = await origOpen.apply(this, arguments);
        try {
          const isRlw =
            this &&
            this.opened &&
            this.vendorId === 0x2e3c &&
            this.productId === 0xc365 &&
            (!Array.isArray(this.collections) ||
              this.collections.length === 0 ||
              this.collections.some(
                (c) => c && c.usagePage === 0xff1b && c.usage === 0x91
              ));
          if (isRlw && typeof this.sendReport === "function") {
            const syncOff = new Uint8Array(63);
            syncOff[0] = 23;
            syncOff[4] = 2;
            await this.sendReport(1, syncOff);
          }
        } catch {}
        return res;
      };
      wrappedOpen.__aulaRlwWrapped = true;
      HIDDevice.prototype.open = wrappedOpen;
    }
  } catch {}

  // 3. Dynamic English translation for Chinese toasts, dialogs, and hardcoded strings
  const EN_MSG_EXACT = {
    "退出登录": "Logged out",
    "登录成功": "Login successful",
    "登录失败": "Login failed",
    "登录失败，邮件或密码错误": "Login failed: incorrect email or password",
    "登录失败,邮件或密码错误": "Login failed: incorrect email or password",
    "邮件或密码错误": "Incorrect email or password",
    "邮箱或密码错误": "Incorrect email or password",
    "账号或密码错误": "Incorrect account or password",
    "密码错误": "Incorrect password",
    "用户不存在": "User does not exist",
    "邮箱不存在": "Email does not exist",
    "邮箱已存在": "Email already exists",
    "该邮箱已注册": "This email is already registered",
    "邮箱已被注册": "This email is already registered",
    "验证码错误": "Invalid verification code",
    "验证码已过期": "Verification code expired",
    "验证码已发送": "Verification code sent",
    "发送验证码失败": "Failed to send verification code",
    "发送过于频繁，请稍后再试": "Too many requests, please try again later",
    "操作频繁，请稍后再试": "Too many requests, please try again later",
    "未登录": "Not logged in",
    "请先登录": "Please log in first",
    "登录已过期": "Session expired, please log in again",
    "登录已过期，请重新登录": "Session expired, please log in again",
    "注册成功": "Registration successful",
    "注册失败": "Registration failed",
    "修改密码成功": "Password changed successfully",
    "修改密码失败": "Failed to change password",
    "请求失败": "Request failed",
    "网络错误": "Network error",
    "请求超时，请稍后重试": "Request timed out, please try again later",
    "参数错误": "Invalid parameter",
    "服务器错误": "Server error, please try again later",
    "服务器异常": "Server error, please try again later",
    "系统错误": "System error, please try again later",
    "服务异常": "Service unavailable, please try again later",
    "更新包格式错误，需要 .zip 文件": "Invalid update package format (.zip required)",
    "网络连接失败，请检查网络": "Network connection failed, please check your connection",
    "更新包校验失败，可能文件已损坏": "Update package verification failed; file may be corrupted",
    "更新包解压失败": "Failed to extract update package",
    "下载中断，请检查网络": "Download interrupted, please check your connection",
    "操作成功": "Operation succeeded",
    "操作失败": "Operation failed",
    "保存成功": "Saved successfully",
    "保存失败": "Failed to save",
    "删除成功": "Deleted successfully",
    "删除失败": "Failed to delete",
    "修改成功": "Updated successfully",
    "修改失败": "Failed to update",
    "上传成功": "Uploaded successfully",
    "上传失败": "Upload failed",
    "导入成功": "Imported successfully",
    "导入失败": "Import failed",
    "导出成功": "Exported successfully",
    "导出失败": "Export failed",
    "复制成功": "Copied successfully",
    "配置码已复制": "Config code copied",
    "生成失败": "Generation failed",
    "已打印到控制台": "Printed to console",
    "名称已存在": "Name already exists",
    "名称不能为空": "Name cannot be empty",
    "暂无数据": "No data",
    "无数据": "No data",
    "无匹配数据": "No matching data",
    "加载中": "Loading...",
    "加载失败": "Failed to load",
    "请选择": "Please select",
    "返回": "Back",
    "提示": "Notice",
    "确认": "OK",
    "确定": "OK",
    "取消": "Cancel",
    "关闭此对话框": "Close this dialog",
    "设备未连接": "Device not connected",
    "固件已是最新版本": "Firmware is already up to date",
    "请输入新建配置名": "Enter new profile name",
    "宏命令步骤最多 20 组动作": "Macro supports up to 20 actions",
    "导入宏配置...": "Importing Macro config...",
    "清空宏配置...": "Clearing Macro config...",
    "导入高级按键配置...": "Importing Advanced Key config...",
    "清空高级按键配置...": "Clearing Advanced Key config...",
    "导入SOCD配置...": "Importing SOCD config...",
    "清空SOCD配置...": "Clearing SOCD config...",
    "导入行程配置...": "Importing Actuation config...",
    "重置行程配置...": "Resetting Actuation config...",
    "导入死区配置...": "Importing Deadzone config...",
    "重置死区配置...": "Resetting Deadzone config...",
    "导入回报率配置...": "Importing Polling Rate config...",
    "导入Win Lock配置...": "Importing Win Lock config...",
    "导入手柄模式配置...": "Importing Gamepad Mode config...",
    "导入休眠定时器配置...": "Importing Sleep Timer config...",
  };

  const EN_MSG_PHRASES = [
    [/登录失败/g, "Login failed"],
    [/注册失败/g, "Registration failed"],
    [/操作失败/g, "Operation failed"],
    [/请求失败/g, "Request failed"],
    [/邮件或密码错误/g, "incorrect email or password"],
    [/邮箱或密码错误/g, "incorrect email or password"],
    [/账号或密码错误/g, "incorrect account or password"],
    [/验证码错误/g, "invalid verification code"],
    [/验证码已过期/g, "verification code expired"],
    [/请稍后重试|请稍后再试/g, "please try again later"],
    [/请检查网络/g, "please check your network"],
    [/请重新登录/g, "please log in again"],
    [/不能为空/g, "cannot be empty"],
    [/已存在/g, "already exists"],
    [/不存在/g, "does not exist"],
    [/不支持/g, "not supported"],
    [/未连接/g, "not connected"],
    [/失败/g, "failed"],
    [/成功/g, "succeeded"],
    [/错误/g, "error"],
    [/超时/g, "timed out"],
    [/网络/g, "network"],
  ];

  function getActiveLang() {
    let lang = "en";
    try {
      const raw = window.localStorage.getItem("aula-store");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.language) lang = parsed.language;
      }
    } catch {}
    return lang;
  }

  function trMsg(s) {
    if (typeof s !== "string" || !s) return s;
    if (getActiveLang() !== "en") return s;
    const trimmed = s.trim();
    if (EN_MSG_EXACT[trimmed]) return EN_MSG_EXACT[trimmed];
    if (!/[\u4e00-\u9fff]/.test(s)) return s;
    let out = s;
    for (const [re, rep] of EN_MSG_PHRASES) out = out.replace(re, rep);
    return out.replace(/，/g, ", ").replace(/：/g, ": ").replace(/。/g, ".");
  }

  window.__aulaEnTrMsg = trMsg;

  const TRANSLATE_SELECTOR = [
    ".toast-item",
    ".el-message-box",
    ".el-message",
    ".el-notification",
    ".el-popconfirm",
    ".el-dialog__title",
    ".el-dialog__headerbtn",
    ".el-select-dropdown__empty",
  ].join(",");

  function translateElementTree(el) {
    if (!el || getActiveLang() !== "en") return;
    if (el.nodeType === 3) {
      const val = el.nodeValue;
      if (val && /[\u4e00-\u9fff]/.test(val)) {
        const parent = el.parentElement;
        if (parent && parent.closest && parent.closest(TRANSLATE_SELECTOR)) {
          const next = trMsg(val);
          if (next !== val) el.nodeValue = next;
        }
      }
      return;
    }
    if (el.nodeType !== 1) return;

    if (el.hasAttribute && el.hasAttribute("placeholder")) {
      const ph = el.getAttribute("placeholder");
      if (ph && EN_MSG_EXACT[ph.trim()]) {
        el.setAttribute("placeholder", EN_MSG_EXACT[ph.trim()]);
      }
    }

    const inScope = el.matches && el.matches(TRANSLATE_SELECTOR)
      ? true
      : Boolean(el.closest && el.closest(TRANSLATE_SELECTOR));

    if (inScope) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const val = node.nodeValue;
        if (val && /[\u4e00-\u9fff]/.test(val)) {
          const next = trMsg(val);
          if (next !== val) node.nodeValue = next;
        }
      }
    } else if (el.querySelectorAll) {
      const targets = el.querySelectorAll(TRANSLATE_SELECTOR);
      for (const t of targets) translateElementTree(t);
      const inputs = el.querySelectorAll("input[placeholder], textarea[placeholder]");
      for (const inp of inputs) {
        const ph = inp.getAttribute("placeholder");
        if (ph && EN_MSG_EXACT[ph.trim()]) {
          inp.setAttribute("placeholder", EN_MSG_EXACT[ph.trim()]);
        }
      }
    }
  }

  function startObserver() {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    if (!root) return;
    translateElementTree(root);
    const obs = new MutationObserver((mutations) => {
      if (getActiveLang() !== "en") return;
      for (const m of mutations) {
        if (m.type === "characterData") {
          translateElementTree(m.target);
        } else if (m.type === "attributes" && m.attributeName === "placeholder") {
          translateElementTree(m.target);
        } else if (m.type === "childList") {
          for (const n of m.addedNodes) translateElementTree(n);
        }
      }
    });
    obs.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder"],
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    } else {
      startObserver();
    }
  }
})();
