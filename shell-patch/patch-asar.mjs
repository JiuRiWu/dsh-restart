// dsh-restart 外壳补丁：给官方 DSH Desktop 的 app.asar 注入「重启」IPC 入口。
//
// 设计要点（全部对齐官方既有写法，不新造机制）：
//   1. 新通道名加进 preload/main.js 两处 DESKTOP_IPC 常量，沿用 `dsh-desktop:` 前缀。
//   2. main.js 的 handler 插在 `quitConfirmation` 构造之后，与 `DESKTOP_IPC.windowsMenu`
//      的 handler 并排——官方惯用法，且此刻 quitConfirmation 已初始化，无 TDZ 风险。
//   3. 确认框直接复用 `quitConfirmation.confirm()`（就是托盘「退出」弹的那个原生框，
//      同一份 inspectQuit 判定逻辑），批准后才 `app.relaunch() + quitWithoutConfirmation()`，
//      后者与官方 `recovery.restart`（main.js:11844-11847）逐字相同。
//   4. 用户点「取消」→ 提前 return，绝不登记 relaunch，因此不会残留「下次退出被意外重启」。
//
// 用法：
//   node patch-asar.mjs check     # 只核对基线：pristine 与当前 app.asar 是否一致、锚点是否唯一
//   node patch-asar.mjs build     # 产出 app.asar.patched（不碰原文件）
//   node patch-asar.mjs verify    # 校验 app.asar.patched 自洽 + 语法
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEntry, repackSync, verifyRepack, sha256 } from './asar-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRISTINE = path.join(HERE, 'pristine');
// 目标归档：默认是这台机器上官方 DSH Desktop 的安装位置。
// install.ps1 会用 DSH_APP_ASAR 把 -AppRoot 传进来，确保「读来做基准的」和
// 「最后被覆盖的」始终是同一个文件。
const APP_ASAR = process.env.DSH_APP_ASAR ?? 'D:\\deepseek\\deepseek HARNESS\\resources\\app.asar';
const DST = path.join(HERE, 'app.asar.patched');

const T = '\t';
const lines = (...ls) => ls.join('\n');

// ---------------------------------------------------------------- 补丁定义
const IPC_CONST_FIND = lines(
  `${T}windowsMenu: "dsh-desktop:windows-menu"`,
  '};',
);
const IPC_CONST_REPLACE = lines(
  `${T}windowsMenu: "dsh-desktop:windows-menu",`,
  `${T}restartApplication: "dsh-desktop:restart-application"`,
  '};',
);

// 插在 quitConfirmation 构造块与紧随其后的 win32 菜单 handler 之间。
const CONF_ANCHOR_FIND = lines(
  `${T}${T}...process.platform === "win32" ? { icon: nativeImage.createFromPath(trayIconPath) } : {}`,
  `${T}});`,
  `${T}if (process.platform === "win32") {`,
);

const RESTART_HANDLER = lines(
  `${T}/**`,
  `${T}* Restart the application from the in-app restart button.`,
  `${T}*`,
  `${T}* The decision is the tray quit's own confirmation, so the user sees the same native box and the`,
  `${T}* same inspection copy; only an approval registers the relaunch, which keeps a cancelled request`,
  `${T}* from resurfacing at a later quit. Approval then takes the crash recovery restart path: relaunch`,
  `${T}* plus the orderly shutdown that waits for the Host to stop.`,
  `${T}*/`,
  `${T}ipcMain.handle(DESKTOP_IPC.restartApplication, async (event) => {`,
  `${T}${T}assertDesktopSender(event, ["app"]);`,
  `${T}${T}const window = mainWindow;`,
  `${T}${T}if (window === void 0 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("desktop restart: rejected sender");`,
  `${T}${T}if (isQuitting()) return false;`,
  `${T}${T}if (!await quitConfirmation.confirm()) return false;`,
  `${T}${T}if (isQuitting()) return false;`,
  `${T}${T}app.relaunch();`,
  `${T}${T}quitWithoutConfirmation();`,
  `${T}${T}return true;`,
  `${T}});`,
);

const CONF_ANCHOR_REPLACE = lines(
  `${T}${T}...process.platform === "win32" ? { icon: nativeImage.createFromPath(trayIconPath) } : {}`,
  `${T}});`,
  RESTART_HANDLER,
  `${T}if (process.platform === "win32") {`,
);

const PRODUCT_API_FIND = lines(
  'function createProductApi() {',
  `${T}return {`,
  `${T}${T}protocolVersion: 1,`,
);
const PRODUCT_API_REPLACE = lines(
  'function createProductApi() {',
  `${T}return {`,
  `${T}${T}protocolVersion: 1,`,
  `${T}${T}restartApplication: () => electron.ipcRenderer.invoke(DESKTOP_IPC.restartApplication),`,
);

const PATCHES = [
  {
    entry: '/lib/main.js',
    pristine: 'main.js',
    edits: [
      { name: 'main:ipc-channel', find: IPC_CONST_FIND, replace: IPC_CONST_REPLACE },
      { name: 'main:restart-handler', find: CONF_ANCHOR_FIND, replace: CONF_ANCHOR_REPLACE },
    ],
  },
  {
    entry: '/lib/preload-app.cjs',
    pristine: 'preload-app.cjs',
    edits: [
      { name: 'preload:ipc-channel', find: IPC_CONST_FIND, replace: IPC_CONST_REPLACE },
      { name: 'preload:product-api', find: PRODUCT_API_FIND, replace: PRODUCT_API_REPLACE },
    ],
  },
];

// ---------------------------------------------------------------- 补丁应用
function applyEdits(text, edits, problems) {
  let out = text;
  for (const e of edits) {
    const hits = out.split(e.find).length - 1;
    if (hits !== 1) {
      problems.push(`${e.name}：锚点命中 ${hits} 次，期望恰好 1 次`);
      continue;
    }
    out = out.replace(e.find, e.replace);
  }
  return out;
}

function buildReplacements({ checkBaseline }) {
  const problems = [];
  const replacements = new Map();
  for (const p of PATCHES) {
    const pristinePath = path.join(PRISTINE, p.pristine);
    if (!fs.existsSync(pristinePath)) {
      // 分享出去的副本刻意不带 pristine/（那是从别人机器上的 app.asar 提取出来的），
      // 所以「基准不存在」是正常起点，不是错误——提示一句就走 refresh 那条路。
      problems.push(
        `${p.entry}：基准副本不存在（${pristinePath}）——先跑一次 refresh 从当前安装的归档提取基准`,
      );
      continue;
    }
    const pristineBuf = fs.readFileSync(pristinePath);
    if (checkBaseline) {
      const live = readEntry(APP_ASAR, p.entry);
      if (live === null) problems.push(`${p.entry}：在 app.asar 里找不到这个文件`);
      else if (!live.equals(pristineBuf)) {
        problems.push(
          `${p.entry}：基准副本与当前安装的归档不一致（基准 sha256 ${sha256(pristineBuf)}，` +
            `现网 ${sha256(live)}）——打补丁前需要先按新版本重新提取基准`,
        );
      }
    }
    const patched = applyEdits(pristineBuf.toString('utf8'), p.edits, problems);
    if (problems.length > 0) continue;
    const buf = Buffer.from(patched, 'utf8');
    replacements.set(p.entry, buf);
    console.log(
      `  ${p.entry}：${pristineBuf.length} -> ${buf.length} 字节（+${buf.length - pristineBuf.length}），` +
        `${p.edits.length} 处改动`,
    );
  }
  return { replacements, problems };
}

function syntaxCheck(archive, entry) {
  const buf = readEntry(archive, entry);
  if (buf === null) return `${entry}: unreadable`;
  const tmp = path.join(os.tmpdir(), `dsh-restart-check-${path.basename(entry)}`);
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return null;
  } catch (error) {
    return `${entry}: ${String(error.stderr ?? error.message).trim().split('\n').slice(0, 4).join(' | ')}`;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------- 入口
const cmd = process.argv[2] ?? 'check';

if (cmd === 'check') {
  console.log(`  当前归档：${APP_ASAR}`);
  console.log(`  基准副本：${PRISTINE}`);
  const { replacements, problems } = buildReplacements({ checkBaseline: true });
  for (const p of problems) console.error(`失败 ${p}`);
  if (problems.length === 0) console.log(`通过：基准一致，${replacements.size} 个条目都能干净地打上补丁`);
  process.exit(problems.length === 0 ? 0 : 1);
} else if (cmd === 'refresh') {
  // DSH 更新会整个换掉 app.asar，pristine/ 里的基准随之过期，build 会（正确地）拒绝重建。
  // 这个子命令从当前安装的归档重新提取基准，并立刻验证四处锚点是否仍然命中：
  // 命中就说明新版本的外壳代码形状没变，可以照常打补丁；不命中就报出来，等人来看。
  const MARK = 'dsh-desktop:restart-application';
  for (const p of PATCHES) {
    const live = readEntry(APP_ASAR, p.entry);
    if (live === null) {
      console.error(`失败 ${p.entry}：在 app.asar 里找不到这个文件`);
      process.exit(1);
    }
    if (live.toString('utf8').includes(MARK)) {
      console.error(
        `失败 ${p.entry}：当前安装的归档里已经带着补丁标记（${MARK}）——` +
          '拒绝把已经打过补丁的代码当成基准，那会重复打一遍补丁',
      );
      process.exit(1);
    }
    const dst = path.join(PRISTINE, p.pristine);
    fs.mkdirSync(PRISTINE, { recursive: true });
    const before = fs.existsSync(dst) ? sha256(fs.readFileSync(dst)).slice(0, 16) : '（尚无）';
    fs.writeFileSync(dst, live);
    console.log(`  基准 ${p.pristine}：${before}… -> ${sha256(live).slice(0, 16)}…（${live.length} 字节）`);
  }
  const { replacements, problems } = buildReplacements({ checkBaseline: true });
  for (const p of problems) console.error(`失败 ${p}`);
  if (problems.length === 0) {
    console.log(`通过：基准已按当前安装的归档续期，${replacements.size} 个条目依然能干净地打上补丁`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
} else if (cmd === 'build') {
  if (!fs.existsSync(APP_ASAR)) {
    console.error(`找不到 app.asar：${APP_ASAR}`);
    process.exit(1);
  }
  if (fs.existsSync(DST)) fs.rmSync(DST);
  const { replacements, problems } = buildReplacements({ checkBaseline: true });
  if (problems.length > 0) {
    for (const p of problems) console.error(`失败 ${p}`);
    process.exit(1);
  }
  const srcSize = fs.statSync(APP_ASAR).size;
  console.log(`  正在重打包 ${srcSize} 字节 -> ${DST}`);
  const started = Date.now();
  const stats = repackSync(APP_ASAR, DST, replacements);
  console.log(
    `  完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒：` +
      `条目 ${stats.entries}，数据起点 ${stats.dataStart}，` +
      `数据 ${stats.dataBytes} 字节，总计 ${stats.totalBytes} 字节`,
  );
  const v = verifyRepack(APP_ASAR, DST, replacements);
  console.log(`  结构校验：${v.ok ? '通过' : JSON.stringify(v.problems, null, 2)}`);
  for (const p of PATCHES) {
    const bad = syntaxCheck(DST, p.entry);
    console.log(`  语法 ${p.entry}：${bad === null ? '通过' : bad}`);
  }
  process.exit(v.ok ? 0 : 1);
} else if (cmd === 'verify') {
  const { replacements } = buildReplacements({ checkBaseline: false });
  const v = verifyRepack(APP_ASAR, DST, replacements);
  console.log(`结构校验：${v.ok ? '通过' : JSON.stringify(v.problems, null, 2)}`, {
    文件总数: v.files,
    归档内实存: v.stored,
    归档大小: v.fileSize,
  });
  for (const p of PATCHES) {
    const bad = syntaxCheck(DST, p.entry);
    console.log(`语法 ${p.entry}：${bad === null ? '通过' : bad}`);
  }
  process.exit(v.ok ? 0 : 1);
} else {
  console.log('用法：patch-asar.mjs check|refresh|build|verify');
  process.exit(1);
}