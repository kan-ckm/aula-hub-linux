#!/usr/bin/env node
/**
 * Version-resilient patcher that eliminates remaining hardcoded Chinese UI strings
 * and dynamically translates Chinese server/toast messages to English when
 * AULA HUB's active language is "en".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "app"
);
const appDir = path.resolve(process.argv[2] || DEFAULT_APP_DIR);
const assetsDir = path.join(appDir, "dist", "assets");
const mainPath = path.join(appDir, "dist-electron", "main.mjs");

if (!fs.existsSync(assetsDir) || !fs.existsSync(mainPath)) {
  console.error(`Invalid AULA HUB app directory: ${appDir}`);
  process.exit(1);
}

const EN_MARKER = "/*__EN_TOAST_PATCHED__*/";

const EN_TOAST_HELPER = `/*__EN_TOAST_PATCHED__*/
const _EN_MSG_EXACT={
  "退出登录":"Logged out",
  "登录成功":"Login successful",
  "登录失败":"Login failed",
  "登录失败，邮件或密码错误":"Login failed: incorrect email or password",
  "登录失败,邮件或密码错误":"Login failed: incorrect email or password",
  "邮件或密码错误":"Incorrect email or password",
  "邮箱或密码错误":"Incorrect email or password",
  "账号或密码错误":"Incorrect account or password",
  "密码错误":"Incorrect password",
  "用户不存在":"User does not exist",
  "邮箱不存在":"Email does not exist",
  "邮箱已存在":"Email already exists",
  "该邮箱已注册":"This email is already registered",
  "邮箱已被注册":"This email is already registered",
  "验证码错误":"Invalid verification code",
  "验证码已过期":"Verification code expired",
  "验证码已发送":"Verification code sent",
  "发送验证码失败":"Failed to send verification code",
  "发送过于频繁，请稍后再试":"Too many requests, please try again later",
  "操作频繁，请稍后再试":"Too many requests, please try again later",
  "未登录":"Not logged in",
  "请先登录":"Please log in first",
  "登录已过期":"Session expired, please log in again",
  "登录已过期，请重新登录":"Session expired, please log in again",
  "注册成功":"Registration successful",
  "注册失败":"Registration failed",
  "修改密码成功":"Password changed successfully",
  "修改密码失败":"Failed to change password",
  "请求失败":"Request failed",
  "网络错误":"Network error",
  "请求超时，请稍后重试":"Request timed out, please try again later",
  "参数错误":"Invalid parameter",
  "服务器错误":"Server error, please try again later",
  "服务器异常":"Server error, please try again later",
  "系统错误":"System error, please try again later",
  "服务异常":"Service unavailable, please try again later",
  "更新包格式错误，需要 .zip 文件":"Invalid update package format (.zip required)",
  "网络连接失败，请检查网络":"Network connection failed, please check your connection",
  "更新包校验失败，可能文件已损坏":"Update package verification failed; file may be corrupted",
  "更新包解压失败":"Failed to extract update package",
  "下载中断，请检查网络":"Download interrupted, please check your connection",
  "操作成功":"Operation succeeded",
  "操作失败":"Operation failed",
  "保存成功":"Saved successfully",
  "保存失败":"Failed to save",
  "删除成功":"Deleted successfully",
  "删除失败":"Failed to delete",
  "修改成功":"Updated successfully",
  "修改失败":"Failed to update",
  "上传成功":"Uploaded successfully",
  "上传失败":"Upload failed",
  "导入成功":"Imported successfully",
  "导入失败":"Import failed",
  "导出成功":"Exported successfully",
  "导出失败":"Export failed",
  "复制成功":"Copied successfully",
  "配置码已复制":"Config code copied",
  "生成失败":"Generation failed",
  "已打印到控制台":"Printed to console",
  "名称已存在":"Name already exists",
  "名称不能为空":"Name cannot be empty",
  "暂无数据":"No data",
  "设备未连接":"Device not connected",
  "固件已是最新版本":"Firmware is already up to date"
};
const _EN_MSG_PHRASES=[
  [/登录失败/g,"Login failed"],
  [/注册失败/g,"Registration failed"],
  [/操作失败/g,"Operation failed"],
  [/请求失败/g,"Request failed"],
  [/邮件或密码错误/g,"incorrect email or password"],
  [/邮箱或密码错误/g,"incorrect email or password"],
  [/账号或密码错误/g,"incorrect account or password"],
  [/验证码错误/g,"invalid verification code"],
  [/验证码已过期/g,"verification code expired"],
  [/请稍后重试|请稍后再试/g,"please try again later"],
  [/请检查网络/g,"please check your network"],
  [/请重新登录/g,"please log in again"],
  [/不能为空/g,"cannot be empty"],
  [/已存在/g,"already exists"],
  [/不存在/g,"does not exist"],
  [/不支持/g,"not supported"],
  [/未连接/g,"not connected"],
  [/失败/g,"failed"],
  [/成功/g,"succeeded"],
  [/错误/g,"error"],
  [/超时/g,"timed out"],
  [/网络/g,"network"]
];
function _enTrMsg(s){
  if(typeof s!=="string"||!s)return s;
  let lang="en";
  try{
    const raw=localStorage.getItem("aula-store");
    if(raw){const parsed=JSON.parse(raw);if(parsed&&parsed.language)lang=parsed.language;}
  }catch{}
  if(lang!=="en")return s;
  const trimmed=s.trim();
  if(_EN_MSG_EXACT[trimmed])return _EN_MSG_EXACT[trimmed];
  if(!/[\\u4e00-\\u9fff]/.test(s))return s;
  let out=s;
  for(const [re,rep] of _EN_MSG_PHRASES)out=out.replace(re,rep);
  return out.replace(/，/g,", ").replace(/：/g,": ").replace(/。/g,".");
}`;

const touched = [];

function patchIndexBundle() {
  const idxFiles = fs
    .readdirSync(assetsDir)
    .filter((f) => /^index-.*\.js$/.test(f));

  let patchedAny = false;
  for (const fname of idxFiles) {
    const fpath = path.join(assetsDir, fname);
    let txt = fs.readFileSync(fpath, "utf8");
    if (!txt.includes("createI18n")) continue;

    let changed = false;

    if (!txt.includes(EN_MARKER)) {
      const toastRe =
        /function\s+([$\w]+)\(([$\w]+),([$\w]+)="success",([$\w]+)=3e3\)\{const\s+([$\w]+)=([$\w]+)\+\+;([$\w]+)\.value\.push\(\{id:\5,message:\2,type:\3,leaving:!1\}\)/;
      const m = toastRe.exec(txt);
      if (!m) {
        throw new Error(`Could not locate toast function in ${fname}`);
      }
      const [full, fnName, msgArg, typeArg, durArg, idVar, seqVar, arrVar] = m;
      const repl = `${EN_TOAST_HELPER}function ${fnName}(${msgArg},${typeArg}="success",${durArg}=3e3){const ${idVar}=${seqVar}++;${arrVar}.value.push({id:${idVar},message:_enTrMsg(${msgArg}),type:${typeArg},leaving:!1})`;
      txt = txt.slice(0, m.index) + repl + txt.slice(m.index + full.length);
      changed = true;
    }

    const batRe =
      /`Aula Hub - \$\{([$\w]+)\?`\$\{\1\} `:""\}电量: \$\{([$\w]+)\}%\$\{([$\w]+)\?" \(充电中\)":""\}`/g;
    if (batRe.test(txt)) {
      txt = txt.replace(
        batRe,
        (_, devVar, pctVar, chgVar) =>
          `\`Aula Hub - \${${devVar}?\`\${${devVar}} \`:""}Battery: \${${pctVar}}%\${${chgVar}?" (Charging)":""}\``
      );
      changed = true;
    }

    if (txt.includes('"请输入新建配置名"')) {
      txt = txt.replaceAll('"请输入新建配置名"', '"Enter new profile name"');
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(fpath, txt, "utf8");
      touched.push(fpath);
    }
    patchedAny = true;
  }

  if (!patchedAny) {
    throw new Error("Could not find main index-*.js bundle");
  }
}

function patchElementPlus() {
  const epFiles = fs
    .readdirSync(assetsDir)
    .filter((f) => /^element-plus-.*\.js$/.test(f));

  const pairs = [
    ['image:{error:"加载失败"}', 'image:{error:"Failed to load"}'],
    ['pageHeader:{title:"返回"}', 'pageHeader:{title:"Back"}'],
    [
      'popconfirm:{confirmButtonText:"确定",cancelButtonText:"取消"}',
      'popconfirm:{confirmButtonText:"OK",cancelButtonText:"Cancel"}',
    ],
    ['dialog:{close:"关闭此对话框"}', 'dialog:{close:"Close this dialog"}'],
    ['drawer:{close:"关闭此对话框"}', 'drawer:{close:"Close this dialog"}'],
    [
      'messagebox:{title:"提示",confirm:"确定",cancel:"取消",error:"输入的数据不合法!",close:"关闭此对话框"}',
      'messagebox:{title:"Notice",confirm:"OK",cancel:"Cancel",error:"Invalid input!",close:"Close this dialog"}',
    ],
    [
      'select:{loading:"加载中",noMatch:"无匹配数据",noData:"无数据",placeholder:"请选择"}',
      'select:{loading:"Loading...",noMatch:"No matching data",noData:"No data",placeholder:"Please select"}',
    ],
    ['mention:{loading:"加载中"}', 'mention:{loading:"Loading..."}'],
    [
      'dropdown:{toggleDropdown:"切换下拉选项"}',
      'dropdown:{toggleDropdown:"Toggle dropdown"}',
    ],
    [
      'cascader:{noMatch:"无匹配数据",loading:"加载中",placeholder:"请选择",noData:"暂无数据"}',
      'cascader:{noMatch:"No matching data",loading:"Loading...",placeholder:"Please select",noData:"No data"}',
    ],
  ];

  for (const fname of epFiles) {
    const fpath = path.join(assetsDir, fname);
    let txt = fs.readFileSync(fpath, "utf8");
    let changed = false;
    for (const [src, dst] of pairs) {
      if (txt.includes(src)) {
        txt = txt.replaceAll(src, dst);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(fpath, txt, "utf8");
      touched.push(fpath);
    }
  }
}

function patchChildChunks() {
  const keyFiles = fs.readdirSync(assetsDir).filter((f) => /^key-.*\.js$/.test(f));
  for (const fname of keyFiles) {
    const fpath = path.join(assetsDir, fname);
    let txt = fs.readFileSync(fpath, "utf8");
    let changed = false;
    const keyPairs = [
      ['"宏命令步骤最多 20 组动作"', '"Macro supports up to 20 actions"'],
      [',"提示",{confirmButtonText:"确认"', ',"Notice",{confirmButtonText:"OK"'],
    ];
    for (const [src, dst] of keyPairs) {
      if (txt.includes(src)) {
        txt = txt.replaceAll(src, dst);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(fpath, txt, "utf8");
      touched.push(fpath);
    }
  }

  const pickerFiles = fs
    .readdirSync(assetsDir)
    .filter((f) => /^softwarePicker-.*\.js$/.test(f));
  for (const fname of pickerFiles) {
    const fpath = path.join(assetsDir, fname);
    let txt = fs.readFileSync(fpath, "utf8");
    let changed = false;
    const pickerPairs = [
      ['title:"选择应用程序"', 'title:"Select Application"'],
      ['filterExeName:"可执行文件 (*.exe)"', 'filterExeName:"Executable (*.exe)"'],
      ['filterAllName:"所有文件 (*.*)"', 'filterAllName:"All Files (*.*)"'],
    ];
    for (const [src, dst] of pickerPairs) {
      if (txt.includes(src)) {
        txt = txt.replaceAll(src, dst);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(fpath, txt, "utf8");
      touched.push(fpath);
    }
  }

  const infoFiles = fs
    .readdirSync(assetsDir)
    .filter((f) => /^info-.*\.js$/.test(f));
  const infoPairs = [
    ['"导入宏配置..."', '"Importing Macro config..."'],
    ['"清空宏配置..."', '"Clearing Macro config..."'],
    ['"导入高级按键配置..."', '"Importing Advanced Key config..."'],
    ['"清空高级按键配置..."', '"Clearing Advanced Key config..."'],
    ['"导入SOCD配置..."', '"Importing SOCD config..."'],
    ['"清空SOCD配置..."', '"Clearing SOCD config..."'],
    ['"导入行程配置..."', '"Importing Actuation config..."'],
    ['"重置行程配置..."', '"Resetting Actuation config..."'],
    ['"导入死区配置..."', '"Importing Deadzone config..."'],
    ['"重置死区配置..."', '"Resetting Deadzone config..."'],
    ['"导入回报率配置..."', '"Importing Polling Rate config..."'],
    ['"导入Win Lock配置..."', '"Importing Win Lock config..."'],
    ['"导入手柄模式配置..."', '"Importing Gamepad Mode config..."'],
    ['"导入休眠定时器配置..."', '"Importing Sleep Timer config..."'],
  ];
  for (const fname of infoFiles) {
    const fpath = path.join(assetsDir, fname);
    let txt = fs.readFileSync(fpath, "utf8");
    if (!txt.includes('"导入宏配置..."') && !txt.includes('"设备按键列表未初始化"')) {
      continue;
    }
    let changed = false;
    for (const [src, dst] of infoPairs) {
      if (txt.includes(src)) {
        txt = txt.replaceAll(src, dst);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(fpath, txt, "utf8");
      touched.push(fpath);
    }
  }
}

function patchMainProcess() {
  let txt = fs.readFileSync(mainPath, "utf8");
  let changed = false;

  const mainExactPairs = [
    [
      '{ show: "显示", exit: "退出", stopGsi: "停止 GameSense 服务" }',
      '{ show: "Show", exit: "Exit", stopGsi: "Stop GameSense Service" }',
    ],
    ['"选择可执行文件"', '"Select Executable"'],
    ['"可执行文件"', '"Executable"'],
    ['"所有文件"', '"All Files"'],
    ['"选择遮罩图片"', '"Select Overlay Image"'],
    ['"图片文件"', '"Image Files"'],
    ['"选择固件文件"', '"Select Firmware File"'],
    ['"固件文件"', '"Firmware Files"'],
    ['"更新包格式错误，需要 .zip 文件"', '"Invalid update package format (.zip required)"'],
    ['"网络连接失败，请检查网络"', '"Network connection failed, please check your connection"'],
    ['"更新包校验失败，可能文件已损坏"', '"Update package verification failed; file may be corrupted"'],
    ['"更新包解压失败"', '"Failed to extract update package"'],
    ['"下载中断，请检查网络"', '"Download interrupted, please check your connection"'],
    ['"用户取消了选择"', '"Selection cancelled by user"'],
    ['"读取文件失败"', '"Failed to read file"'],
    ['"日志文件不存在"', '"Log file does not exist"'],
    ['|| "请求失败"', '|| "Request failed"'],
  ];

  for (const [src, dst] of mainExactPairs) {
    if (txt.includes(src)) {
      txt = txt.replaceAll(src, dst);
      changed = true;
    }
  }

  const profileRe1 = /`已切换为【板载配置\$\{([$\w]+)\}】`/g;
  if (profileRe1.test(txt)) {
    txt = txt.replace(profileRe1, (_, v) => `\`Switched to [Profile \${${v}}]\``);
    changed = true;
  }

  const profileRe2 = /`已切换为板载配置\$\{([^}]+)\}`/g;
  if (profileRe2.test(txt)) {
    txt = txt.replace(profileRe2, (_, expr) => `\`Switched to Profile \${${expr}}\``);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(mainPath, txt, "utf8");
    touched.push(mainPath);
  }
}

patchIndexBundle();
patchElementPlus();
patchChildChunks();
patchMainProcess();

console.log(
  `patch_notifications_en.mjs: ${touched.length} file(s) updated in ${appDir}`
);
for (const p of touched) {
  console.log(" -", path.relative(appDir, p));
}
