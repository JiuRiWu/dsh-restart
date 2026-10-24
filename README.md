# dsh-restart · DSH Desktop 侧边栏「重启」按钮

给官方 DSH Desktop 的侧边栏底部加一个**重启**按钮。点下去看到的是**托盘「退出 DeepSeek Harness」那个原生确认框**（「还有对话在运行吗」那一套），确认后旧进程优雅退出、完全停稳，再重新拉起。

---

## 1. 为什么需要动外壳

DSH 插件跑在 Host 子进程里，而**退出与重启的唯一权威是 Electron 主进程**。查证过的事实：

| 事实 | 证据位置（`resources/app.asar` 内） |
| --- | --- |
| 插件侧拿不到任何退出/重启入口 | `lib/preload-app.cjs` 的 `DESKTOP_IPC` 共 25 个通道，无一是 quit/restart |
| 外壳↔Host 只有 `control` 一条通道，且方向是外壳→子进程 | `lib/main.js` 只认 `update-tasks` / `quit-inspection` 两种回包 |
| 关窗口不退出，只是收进托盘 | `main.js` 的 `window.on("close")` → `hideMainWindow()` |
| 托盘退出走 `app.quit()` → 原生确认 → 优雅关闭 | `main.js` 的 `before-quit` + `DesktopQuitConfirmation` |
| 重启原语只有 `app.relaunch()`，且仅用于崩溃恢复与开发模式菜单 | `main.js` 的 `recovery.restart` |

连本机最成熟的插件 `dshmarket` 都明确不为桌面端提供重启，它的注释写着：

> Restart keeps the stricter predicate — it spawns a replacement host, which is not something a desktop-managed profile should get from here.

所以结论是：**要满足「关闭必须等同托盘退出」这个要求，只能在外壳上开一个口子**。这个口子不新造任何机制，只是把外壳里已有的东西接到界面上。

---

## 2. 怎么做的

### 外壳补丁（3 处注入，共 1149 字节）

1. `lib/main.js` + `lib/preload-app.cjs` 各自的 `DESKTOP_IPC` 常量加一行：
   `restartApplication: "dsh-desktop:restart-application"`（沿用官方 `dsh-desktop:` 前缀）
2. `lib/main.js` 在 `quitConfirmation` 构造之后、紧挨 `DESKTOP_IPC.windowsMenu` 处理器插入新 handler
3. `lib/preload-app.cjs` 的 `createProductApi()` 暴露 `restartApplication()`

handler 的全部逻辑就是这么几行：

```js
ipcMain.handle(DESKTOP_IPC.restartApplication, async (event) => {
    assertDesktopSender(event, ["app"]);          // 官方同款来源校验
    const window = mainWindow;
    if (window === void 0 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("desktop restart: rejected sender");
    if (isQuitting()) return false;
    if (!await quitConfirmation.confirm()) return false;   // ← 就是托盘那个原生框，同一份判定
    if (isQuitting()) return false;
    app.relaunch();                                        // ← 官方 recovery.restart 的原话
    quitWithoutConfirmation();
    return true;
});
```

三个关键取舍：

- **复用 `quitConfirmation.confirm()`**，而不是自绘对话框。用户看到的就是托盘退出时那个框，文案、按钮、`inspectQuit` 判定（有无正在运行/已排期的对话）全都一致。
- **只在批准后才登记 relaunch**。`app.relaunch()` 一旦调用就会留下待重启标记；如果先登记再弹框，用户点「取消」后会残留，导致他日后的正常退出被意外重启。这里的顺序保证取消 = 什么都没发生。
- **`quitWithoutConfirmation()` 是官方既有函数**，它设的 `skipQuitConfirmation` 在官方注释里的用途正是「不需要再问的退出入口」（崩溃恢复退出/重启、开发模式重启）。我们已经在前面问过了，所以走它，避免弹第二次框。

### 插件（纯客户端）

仓库根目录就是一个标准 DSH bundle：宿主半边 `index.js` 是空 `apply`，浏览器半边 `client.js` 往 `sidebar.footer.action` 注册一个按钮。

按钮样式照抄官方侧边栏底部按钮（`@deepseek-ai/dsh-client-ui-cordis` 的 `.badge`）：宽态 42px 行高 + 图标 + 文字，侧边栏收起时切成 36px 圆形 rail 按钮，只用 `--dsw-alias-*` 令牌。**没有 import `@deepseek-ai/dsh-client-ui-primitives`** ——官方 practices 明确禁止插件依赖它。

按钮自己不做任何关闭动作，只调 `window.dshDesktop.restartApplication()`。找不到入口时（补丁没打）按钮变禁用并在 tooltip 里说明原因，不会静默失效。

---

## 3. 目录

```
dsh-restart/                  ← 仓库根目录同时就是这个 DSH 插件包
├─ README.md                  ← 本文件
├─ LICENSE                    MIT
├─ .gitignore                 排除本机产物与提取出来的官方源码
├─ package.json               dsh.bundle.patch + dsh.client(platform: web, inject: ui-sidebar)
├─ cordis.patch.yml           - insert: [{ id: dsh-restart, name: dsh-restart }]
├─ index.js                   宿主半边（空 apply）
├─ client.js                  浏览器半边（按钮本体）
├─ locale/{zh,en}.json        插件列表里的标题与说明
├─ icon.svg / icon.png        精选列表只收位图，所以两个都留
├─ dist/                      ← 打包好、可直接发给别人的副本（约 28 KB，见第 9 节）
└─ shell-patch/               ← 外壳补丁工具链
   ├─ common.ps1              公共函数：自动定位 DSH 安装目录 / 找 node
   ├─ asar-lib.mjs            零依赖 asar 读写库（重打包 + 结构校验）
   ├─ patch-asar.mjs          补丁定义与执行：check / refresh / build / verify
   ├─ install.ps1             备份 + 换上补丁版
   ├─ restore.ps1             还原原始 asar
   ├─ apply-on-exit.ps1       退出后自动打补丁的执行者（由计划任务拉起）
   ├─ apply-on-exit.cmd       计划任务的实际入口（刻意纯 ASCII）
   ├─ recon-asar.mjs          结构勘察 + Electron fuse 解码（开发用）
   ├─ pristine/               补丁基准 —— 本机产物，**不随分享包分发**
   └─ app.asar.patched        成品 —— 本机产物，**不随分享包分发**
```

---

## 4. 安装（两步）

### 第 1 步：外壳补丁

**必须先退出 DSH Desktop**（运行中的 Electron 握着 `app.asar`，Windows 不允许替换）。请照常用托盘右键菜单「退出 DeepSeek Harness」退出——安装脚本不会代劳关闭，也不会强杀任何进程。

```powershell
powershell -ExecutionPolicy Bypass -File "<本目录>\shell-patch\install.ps1"
```

脚本会：自动定位 DSH 安装目录 → 检测进程是否已退出 → 按当前 asar 重新生成补丁版 → 首次安装时备份原文件到 `resources\app.asar.dsh-restart-backup` → 换上补丁版并校验 SHA256。

安装目录是**自动探测**的（运行中的进程 → 开始菜单/桌面快捷方式 → 注册表卸载项 → 常见位置）。探测失败或装在别处时，加 `-AppRoot "D:\你的路径"` 显式指定。

### 第 2 步：装插件

重新启动 DeepSeek Harness，然后在 DSH 里让 agent 用 plugin manager 装这个**目录**（路径就填这个绝对路径）：

```
<本目录的绝对路径>
```

也就是 `plugin_manager` 的 `install_bundle`，`target` 用上面的绝对目录。装完侧边栏底部就会出现「重启」。

> 为什么不直接改 profile：官方 `cordis-plugin-development` skill 明确禁止手写 profile 的 `package.json` / `cordis.patch.yml`，也禁止在 profile 目录里跑 pnpm。走 plugin manager 是唯一被支持的路。

---

## 5. 验证清单

补丁在副本上已通过以下校验（可复跑 `node shell-patch/patch-asar.mjs verify`）：

- 零改动往返自检**逐字节相同**（182,794,869 字节）——证明解析偏移、数据起始、哈希约定三项全对
- 提取出的 `main.js` / `preload-app.cjs` 的 SHA256 与 asar 头部 integrity 完全吻合
- 16726 个条目全部保留，`dataStart` 未变（4,779,796），数据区仅 +1149 字节
- 结构校验：每个未替换文件的大小与 integrity 哈希都与原件一致
- 两个注入文件 `node --check` 语法均通过

还需要你在真机上点一下确认的（脚本无法代劳）：

1. 启动后侧边栏底部出现「重启」按钮
2. 点它 → 弹出与托盘退出**同一个**原生确认框
3. 点「取消」→ 窗口照常，之后再从托盘退出**不应**发生自动重启
4. 点确认 → 旧进程退出、重新拉起

---

## 6. 卸载

```powershell
# 还原外壳（先退出应用）
powershell -ExecutionPolicy Bypass -File "...\shell-patch\restore.ps1"

# 插件：在 DSH 里用 plugin manager 移除 dsh-restart
```

还原后按钮会自动变成禁用态，不会报错。

---

## 7. 注意事项

- **DSH 升级会覆盖 `app.asar`**，补丁需要重打（插件本身还在）。补救步骤见下面第 8 节——重跑一次 `install.ps1` 就行，基准续期是自动的。
- 本机 Electron fuse `EnableEmbeddedAsarIntegrityValidation` 为 **disabled**，所以改 asar 不会触发启动校验。若未来版本打开这个 fuse，该补丁会失效（这也是升级后要先跑 `check` 的原因之一）。
- `app.relaunch()` 是官方崩溃恢复「重启」按钮用的同一个原语，新进程在旧进程退出后才被拉起。若遇到个别情况下新进程抢不到单实例锁，表现为「重启后只是聚焦了旧窗口」——这种情况下请反馈，可以改成「等旧进程 PID 消失后再拉起」的守护方式。
- 补丁**不改动**任何既有退出行为：托盘退出、关窗口收托盘、崩溃恢复对话框全部原样。

---

## 8. DSH 更新之后

DSH 更新会整个换掉 `resources\app.asar`，补丁随之消失：侧边栏按钮会变成禁用态并提示「配套的外壳补丁未安装」（**不会报错**），而 `dsh-restart` 插件本身仍留在 profile 里。

**补救只需重跑一次安装脚本：**

```powershell
# 1) 照常用托盘右键菜单「退出 DeepSeek Harness」退出
# 2) 再跑安装
powershell -ExecutionPolicy Bypass -File "...\shell-patch\install.ps1"
```

脚本对「更新过」这件事是自知的，会依次自动完成：

1. `check` 发现 `pristine/` 基准与新版 asar 不一致 → 自动 `refresh`，从新版 asar 重新提取 `pristine/main.js` 与 `pristine/preload-app.cjs`；
2. 四处锚点若仍然命中 → 按新版生成补丁版并换上；
3. 备份文件里存的是**上一版**原始件（单独还原它等于把 DSH 降级回旧版本），脚本会把它替换为新版原始件，并把新旧两个 SHA256 都打出来。

**唯一的失败模式**：新版外壳若改动了那四处的代码形状，`refresh` 之后锚点命中数不为 1，脚本会明确报错并且**一个字节都不改**（绝不猜着往里写）。此时需要人工更新 `patch-asar.mjs` 里的锚点。

也可以只跑单步：

```powershell
node shell-patch/patch-asar.mjs refresh   # 只续期基准
node shell-patch/patch-asar.mjs check     # 只看能不能打，不改任何文件
```

> `refresh` 会拒绝把已经打过补丁的 asar 当成新基准（那会导致重复打补丁），所以请始终对**原始**的 asar 跑它。

---

## 9. 分享给朋友

已经打包好一份可直接转发的东西：

```
dsh-restart\dsh-restart-分享版.zip      27 KB
```

解压出来是一个干净的 `dsh-restart\` 目录（`dist\` 里是同一份内容，未压缩）：

```
dsh-restart/
├─ 安装说明.md          ← 给朋友看的，从零讲到卸载
├─ 安装.cmd             ← 双击它就行（纯 ASCII，不怕代码页）
├─ plugin/              ← 8 个文件：装进 DSH 的插件
└─ shell-patch/         ← 7 个文件：补丁工具链
```

**这个包里刻意不含两样东西**：

| 不含 | 原因 |
| --- | --- |
| `pristine/`（补丁基准） | 那是 DeepSeek 外壳源码的副本，不该由我转发 |
| `app.asar.patched`（成品） | 182 MB；而且它是按**我这台机器**的版本打的 |

朋友那边首次运行时，`install.ps1` 会调用 `refresh`，从**他自己那份 `app.asar`** 现场提取基准再打补丁。所以每个人拿到的补丁版都是按自己的版本定制的，字节数不一定相同——这是对的，不是问题。

**朋友那边要做的**：

1. 确认装了 DSH Desktop（Windows）。**不需要额外装 Node**——脚本会先用 DSH 自带的运行时 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。
2. 从托盘右键「退出 DeepSeek Harness」退出 DSH。
3. 解压，双击 `安装.cmd`。装在别处或自动探测失败时，脚本会提示改用
   `powershell -ExecutionPolicy Bypass -File shell-patch\install.ps1 -AppRoot "D:\路径"`。
4. 重新打开 DeepSeek Harness，让 agent 用 plugin manager 装 `plugin` 目录（第 4 节第 2 步）。
5. 之后想省事，就注册那个计划任务（`apply-on-exit`），以后退出时自动打补丁。

**要跟朋友讲清楚的两件事**：

- 这是**改安装包**：动了 `resources\app.asar`。DSH 更新会把它整个换掉，补丁随之失效——按钮会变灰并提示「配套的外壳补丁未安装」，不会报错也不会崩。重跑一次安装即可（`pristine/` 会自动续期）。
- 想彻底撤掉：`powershell -ExecutionPolicy Bypass -File shell-patch\restore.ps1`，外加在 DSH 里卸载 `dsh-restart` 插件。

---

## 退出后自动应用补丁（apply-on-exit）

运行中的 DSH 锁着 `resources\app.asar`，所以补丁**只能**在 DSH 退出后落地。
`apply-on-exit.ps1` 就是为此准备的执行者：它由**计划任务**拉起，不是 DSH 的子进程，
因此 DSH 退出时它仍然活着，可以接手完成替换。

它绝不做的事：不关闭 DSH、不强杀任何进程。它只是**等待**你像平常那样从托盘右键菜单
选择「退出 DeepSeek Harness」，等 DSH 自然退出后才动手。

### 启动它

```powershell
schtasks /run /tn "dsh-restart-apply-on-exit"
```

启动后的完整流程：等 DSH 退出 → 等 asar 解锁 → 调用 `install.ps1` → 弹框问你是否重开 DSH。

### 反悔 / 取消

- 在本目录新建一个空文件 `apply-on-exit.cancel`，执行者会在 2 秒内放弃，**不做任何改动**。
- 或删除计划任务：`schtasks /delete /tn "dsh-restart-apply-on-exit" /f`。
  注意 `schtasks /end` 只结束任务本身，它拉起的 PowerShell 子进程可能残留，
  需在任务管理器里结束 `powershell.exe`（命令行含 `apply-on-exit.ps1` 的那个）。
- `apply-on-exit.log` 记录全过程，包括 `install.ps1` 的完整输出。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-AppRoot` | 自动探测 | 安装根目录；探测失败时显式指定 |
| `-WaitSeconds` | `86400` | 最多等多久（秒），超时则不做任何改动 |
| `-After` | `ask` | 打完补丁后：`ask` 询问 / `relaunch` 直接重开 / `none` 什么都不做 |
| `-TaskName` | `dsh-restart-apply-on-exit` | 计划任务名 |

### 为什么 `.ps1` 必须带 UTF-8 BOM

Windows PowerShell 5.1（计划任务实际使用的解释器）会把**没有 BOM** 的 `.ps1`
按系统 ANSI 代码页解码。脚本里全是中文，一旦被误解码就会报出莫名其妙的
「字符串缺少终止符」之类的语法错误——脚本本身其实没问题。
`apply-on-exit.cmd` 则刻意只写 ASCII：`cmd.exe` 也按 OEM 代码页读它。
