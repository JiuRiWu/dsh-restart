# dsh-restart 外壳补丁 · 还原
#
# 把 app.asar 换回安装前的原始文件。同样要求 DSH Desktop 已经退出。
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [switch]$RemoveBackup
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 定位 DSH Desktop 安装目录（实现见 common.ps1）------------------------
. (Join-Path $here 'common.ps1')
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    Write-Host '未指定 -AppRoot，正在自动查找 DSH Desktop 安装目录…' -ForegroundColor DarkGray
}
$AppRoot = Find-AppRoot $AppRoot
Write-Host "使用的安装目录：$AppRoot" -ForegroundColor DarkGray

$asarPath = Join-Path $AppRoot 'resources\app.asar'
$backupPath = Join-Path $AppRoot 'resources\app.asar.dsh-restart-backup'
$infoPath = Join-Path $here 'backup-info.json'

Write-Host '== dsh-restart 外壳补丁 · 还原 ==' -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $backupPath)) { throw "找不到备份：$backupPath（无需还原，或备份已被删除）" }

$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "检测到 $($running.Count) 个 'DeepSeek Harness' 进程仍在运行，已中止。" -ForegroundColor Yellow
    Write-Host '请从托盘右键菜单选择「退出 DeepSeek Harness」退出应用，然后重新运行本脚本。' -ForegroundColor Yellow
    exit 2
}

$backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
if (Test-Path -LiteralPath $infoPath) {
    $recorded = (Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json).originalHash
    if ($recorded -and $recorded -ne $backupHash) {
        Write-Host "警告：备份哈希与安装时记录的不一致。" -ForegroundColor Yellow
        Write-Host "  记录值 $recorded" -ForegroundColor Yellow
        Write-Host "  实际值 $backupHash" -ForegroundColor Yellow
        throw '为避免还原成错误文件，已中止。'
    }
}

Copy-Item -LiteralPath $backupPath -Destination $asarPath -Force
$afterHash = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
if ($afterHash -ne $backupHash) { throw '还原后哈希不一致，可能未成功。' }

Write-Host '已还原为原始 app.asar。' -ForegroundColor Green
Write-Host "  sha256 : $afterHash"

if ($RemoveBackup) {
    Remove-Item -LiteralPath $backupPath -Force
    Write-Host "已删除备份：$backupPath" -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '注意：外壳补丁去掉后，侧边栏的重启按钮会因为找不到入口而变为禁用状态（不会报错）。'