# dsh-restart 外壳补丁 · 退出后自动应用
#
# 为什么需要它：运行中的 DSH 锁着 resources\app.asar，无法替换；而补丁必须在 DSH
# 退出后才能落地。本脚本由「计划任务」拉起（不是 DSH 的子进程），因此 DSH 退出时
# 它仍然活着，可以接手完成替换。
#
# 它绝不做的事：不关闭 DSH、不强杀任何进程。它只是**等待**用户像平常那样从托盘
# 右键菜单选择「退出 DeepSeek Harness」；等 DSH 自然退出后才动手。
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [int]$WaitSeconds = 86400,                                 # 最多等 24 小时
    [ValidateSet('ask', 'relaunch', 'none')]
    [string]$After = 'ask',                                    # 打完补丁后：询问 / 直接重开 / 什么都不做
    [string]$TaskName = 'dsh-restart-apply-on-exit'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'apply-on-exit.log'
$install = Join-Path $here 'install.ps1'

function Write-Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}
# ---- 定位 DSH Desktop 安装目录 --------------------------------------------
# 探测顺序：显式参数 → 正在运行的进程 → 快捷方式 → 注册表 → 常见位置（实现见 common.ps1）。
# 本脚本通常在 DSH 仍在运行时就被拉起，所以「正在运行的进程」这一步能生效。
. (Join-Path $here 'common.ps1')
try {
    $AppRoot = Find-AppRoot $AppRoot
} catch {
    Write-Log "找不到 DSH Desktop 安装目录，未做任何改动：$($_.Exception.Message)"
    exit 8
}
$asar = Join-Path $AppRoot 'resources\app.asar'
$exe = Join-Path $AppRoot 'DeepSeek Harness.exe'
Write-Log "使用的安装目录：$AppRoot"

function Show-Info([string]$text, [string]$title) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            $text, $title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch { Write-Log "对话框不可用：$($_.Exception.Message)" }
}

function Show-Ask([string]$text, [string]$title) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $r = [System.Windows.Forms.MessageBox]::Show(
            $text, $title,
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question)
        return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
    } catch { Write-Log "对话框不可用：$($_.Exception.Message)"; return $false }
}

function Remove-SelfTask {
    try {
        & schtasks.exe /delete /tn $TaskName /f 2>&1 | Out-Null
        Write-Log "已清理计划任务 $TaskName"
    } catch { Write-Log "计划任务清理失败（可忽略）：$($_.Exception.Message)" }
}

# ---- 0. 单实例闸门 --------------------------------------------------------
# 计划任务若被触发两次（或有人手点了一次），两个执行者会抢着改同一份 asar。
# 用独占打开的锁文件把后来者挡掉；$lock 必须留到进程结束，句柄一关锁就释放。
$lockPath = Join-Path $here 'apply-on-exit.lock'
$cancelPath = Join-Path $here 'apply-on-exit.cancel'
try {
    $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    Write-Log '已有另一个执行者正在运行，本实例直接退出。'
    exit 6
}

# 想反悔：在本目录新建一个空文件 apply-on-exit.cancel，本脚本会在下一轮（≤2 秒）
# 或动手前的最后一刻放弃，不做任何改动。
function Test-Cancelled {
    if (Test-Path -LiteralPath $cancelPath) {
        Write-Log "发现取消文件，放弃本次安装（未做任何改动）：$cancelPath"
        Remove-SelfTask
        return $true
    }
    return $false
}

Write-Log '=== 开始：等待 DSH 退出 ==='

# ---- 1. 等待所有 DSH 进程自然退出（绝不代劳关闭） -------------------------
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ($true) {
    if (Test-Cancelled) { exit 7 }
    $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) {
        Write-Log "等待超时（$WaitSeconds 秒），未做任何改动。"
        Remove-SelfTask
        exit 3
    }
    Start-Sleep -Seconds 2
}
Write-Log 'DSH 已退出。'

if (Test-Cancelled) { exit 7 }

# ---- 2. 等 app.asar 真正解锁 ---------------------------------------------
Write-Log '等待 app.asar 释放文件锁…'
$unlocked = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
        $fs.Close(); $fs.Dispose()
        $unlocked = $true; break
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $unlocked) {
    Write-Log 'app.asar 在 60 秒内仍未解锁，放弃（未做任何改动）。'
    Show-Info "app.asar 仍被占用，补丁未应用。`n`n请确认 DeepSeek Harness 已完全退出，然后手动运行：`n$install" 'dsh-restart 外壳补丁'
    Remove-SelfTask
    exit 4
}
Write-Log 'app.asar 已解锁。'

# ---- 3. 应用补丁（独立进程调用 install.ps1，避免其 exit 影响本脚本） ------
Write-Log '调用 install.ps1 …'
$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $install -AppRoot $AppRoot 2>&1
$code = $LASTEXITCODE
foreach ($l in $out) { Write-Log "  [install] $l" }

# ---- 4. 结果处理 ----------------------------------------------------------
if ($code -ne 0) {
    Write-Log "安装失败，退出码 $code。"
    Show-Info "外壳补丁安装失败（退出码 $code）。`n`n原始 app.asar 未被破坏，安装包仍可用。`n详情见日志：`n$log" 'dsh-restart 外壳补丁'
    Remove-SelfTask
    exit 5
}

Write-Log '补丁安装成功。'
Remove-SelfTask

if ($After -eq 'none') { exit 0 }

$relaunch = $true
if ($After -eq 'ask') {
    $relaunch = Show-Ask "外壳补丁已装好。`n`n现在重新打开 DeepSeek Harness 吗？`n（重新打开后，侧边栏底部的「重启」按钮就会出现）" 'dsh-restart 外壳补丁'
}

if ($relaunch) {
    Write-Log '正在重新打开 DeepSeek Harness …'
    Start-Process -FilePath $exe -WorkingDirectory $AppRoot
    Write-Log '已拉起。'
} else {
    Write-Log '用户选择不重新打开。'
    Show-Info "补丁已就绪。下次打开 DeepSeek Harness 时「重启」按钮即会生效。" 'dsh-restart 外壳补丁'
}