# dsh-restart 外壳补丁 · 安装
#
# 做四件事：1) 确认 DSH Desktop 已退出；2) 用 patch-asar.mjs 重新生成补丁版 asar；
# 3) 首次安装时把原始 app.asar 备份下来；4) 把补丁版换上并校验哈希。
#
# 之所以要求「先退出」：运行中的 Electron 正握着 app.asar，Windows 不会让文件被替换。
# 请照常用托盘右键菜单「退出 DeepSeek Harness」退出（那条路会走原生确认框与优雅关闭），
# 本脚本绝不代劳关闭、也不会强杀任何进程。
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 定位 DSH Desktop 安装目录 --------------------------------------------
# 探测顺序：显式参数 → 正在运行的进程 → 快捷方式 → 注册表 → 常见位置（实现见 common.ps1）
. (Join-Path $here 'common.ps1')

if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    Write-Host '未指定 -AppRoot，正在自动查找 DSH Desktop 安装目录…' -ForegroundColor DarkGray
}
$AppRoot = Find-AppRoot $AppRoot
Write-Host "使用的安装目录：$AppRoot" -ForegroundColor DarkGray

$asarPath = Join-Path $AppRoot 'resources\app.asar'
$backupPath = Join-Path $AppRoot 'resources\app.asar.dsh-restart-backup'
$patchedPath = Join-Path $here 'app.asar.patched'
$infoPath = Join-Path $here 'backup-info.json'


Write-Host '== dsh-restart 外壳补丁 · 安装 ==' -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $asarPath)) { throw "找不到 app.asar：$asarPath（用 -AppRoot 指定安装根目录）" }

# 让 patch-asar.mjs 也认这个 -AppRoot：它的默认目标是官方安装位置，不传的话会出现
# 「按 A 的代码生成补丁版、却覆盖到 B 的 asar 上」这种错配。
$env:DSH_APP_ASAR = $asarPath

# ---- 1. 确认应用已退出 -------------------------------------------------
$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "检测到 $($running.Count) 个 'DeepSeek Harness' 进程仍在运行，已中止。" -ForegroundColor Yellow
    Write-Host '请从托盘右键菜单选择「退出 DeepSeek Harness」退出应用，然后重新运行本脚本。' -ForegroundColor Yellow
    $running | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String | Write-Host
    exit 2
}

# ---- 1b. 已经是补丁版就直接退出 ------------------------------------------
# patch-asar.mjs 的基线校验要求现网 asar 与 pristine 基准一致，所以已打过补丁时它会
# （正确地）拒绝重建 —— 于是「重复运行安装脚本」只会得到一个看不懂的构建失败。
# 这里先识别出来并正常收尾，不做任何改动。
if ((Test-Path -LiteralPath $patchedPath) -and (Test-Path -LiteralPath $backupPath)) {
    $srcHash = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
    $nowHash = (Get-FileHash -LiteralPath $patchedPath -Algorithm SHA256).Hash
    if ($srcHash -eq $nowHash) {
        Write-Host '当前已经是补丁版，无需重复安装。' -ForegroundColor Green
        Write-Host "  app.asar sha256 : $srcHash"
        Write-Host "  如需还原          : powershell -ExecutionPolicy Bypass -File `"$(Join-Path $here 'restore.ps1')`""
        exit 0
    }
}

# ---- 2. 重新生成补丁版 asar（保证与当前安装的 asar 同源） ----------------
$node = Find-Node -Explicit $Node
$script = Join-Path $here 'patch-asar.mjs'
Write-Host "使用 node：$node"

# 2a. 先核对基准。DSH 更新过就会不一致 —— 那不是故障，而是「该换基准了」。
& $node $script check
if ($LASTEXITCODE -ne 0) {
    Write-Host '基准与当前 app.asar 不一致（通常是 DSH 刚更新过），正在按新版本重新提取基准…' -ForegroundColor Yellow
    & $node $script refresh
    if ($LASTEXITCODE -ne 0) {
        throw '新版外壳代码与补丁锚点不匹配，补丁脚本需要人工更新。未改动任何文件。'
    }
    Write-Host '基准已更新，四处锚点仍然命中。' -ForegroundColor Green
}

Write-Host '正在按当前 app.asar 生成补丁版…'
& $node $script build
if ($LASTEXITCODE -ne 0) { throw "补丁构建失败（退出码 $LASTEXITCODE），未改动任何文件。" }

# ---- 3. 备份原始 asar ----------------------------------------------------
# 备份的语义是「这台机器上未被我们改过的 app.asar」，三种情况分别处理：
#   · 没有备份           -> 建一份
#   · 有备份且与现网相同 -> 保持不动
#   · 有备份但与现网不同 -> DSH 更新过了。旧备份是上一版的原始件，更新之后它已经没有
#                           还原价值（单独还原它等于把新版本降级回旧版本），所以用当前
#                           这份新版原始件替换它。
# 能走到这里就说明上面 check/refresh 已经通过，当前 app.asar 是可打补丁的原始件。
$sourceHash = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
if (-not (Test-Path -LiteralPath $backupPath)) {
    Copy-Item -LiteralPath $asarPath -Destination $backupPath
    $originalHash = $sourceHash
    Write-Host "已备份原始 app.asar -> $backupPath" -ForegroundColor Green
} else {
    $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    if ($backupHash -eq $sourceHash) {
        $originalHash = $backupHash
    } else {
        Write-Host 'app.asar 与已有备份不一致：DSH 更新过。' -ForegroundColor Yellow
        Write-Host "  旧备份（上一版原始件，已无还原价值） sha256 $backupHash" -ForegroundColor DarkGray
        Write-Host "  新版原始件                           sha256 $sourceHash" -ForegroundColor DarkGray
        Copy-Item -LiteralPath $asarPath -Destination $backupPath -Force
        $originalHash = $sourceHash
        Write-Host '已把备份更新为新版原始 app.asar。' -ForegroundColor Green
    }
}

# ---- 4. 换上补丁版并校验 ------------------------------------------------
$patchedHash = (Get-FileHash -LiteralPath $patchedPath -Algorithm SHA256).Hash
Copy-Item -LiteralPath $patchedPath -Destination $asarPath -Force
$afterHash = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
if ($afterHash -ne $patchedHash) { throw '替换后哈希不一致，安装可能未成功。' }

@{
    appRoot      = $AppRoot
    asar         = $asarPath
    originalHash = $originalHash
    patchedHash  = $patchedHash
    installedAt  = (Get-Date).ToString('o')
    version      = 1
} | ConvertTo-Json | Set-Content -LiteralPath $infoPath -Encoding UTF8

Write-Host '安装完成。' -ForegroundColor Green
Write-Host "  原始 asar sha256 : $originalHash"
Write-Host "  补丁 asar sha256 : $patchedHash"
Write-Host "  反向还原          : powershell -ExecutionPolicy Bypass -File `"$(Join-Path $here 'restore.ps1')`""
Write-Host ''
Write-Host '下一步：重新启动 DeepSeek Harness，再把 plugin 目录装成 DSH 插件（见 README.md）。'