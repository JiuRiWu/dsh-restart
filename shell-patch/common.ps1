# dsh-restart 外壳补丁 · 公共函数
#
# install.ps1 / restore.ps1 / apply-on-exit.ps1 都用
#     . (Join-Path $PSScriptRoot 'common.ps1')
# 加载本文件。这里只解决「怎么在这台机器上找到 DSH」，不碰任何文件。

# 一个目录是不是 DSH Desktop 的安装根目录
function Test-AppRoot {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Root 'resources\app.asar'))
}

# 依次探测：显式参数 → 正在运行的进程 → 开始菜单/桌面快捷方式 → 注册表 → 常见位置
function Find-AppRoot {
    param([string]$Explicit = '')
    if (Test-AppRoot $Explicit) { return $Explicit }

    $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } | Select-Object -First 1
    if ($running) {
        $cand = Split-Path -Parent $running.Path
        if (Test-AppRoot $cand) { return $cand }
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $lnkDirs = @(
            (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
            (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
            [Environment]::GetFolderPath('Desktop')
        )
        foreach ($dir in $lnkDirs) {
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            foreach ($lnk in @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
                try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
                if ($target -and (Split-Path -Leaf $target) -eq 'DeepSeek Harness.exe') {
                    $cand = Split-Path -Parent $target
                    if (Test-AppRoot $cand) { return $cand }
                }
            }
        }
    } catch { }

    foreach ($hive in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
        )) {
        foreach ($key in @(Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
            $info = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($info.DisplayName -like '*DeepSeek Harness*' -and $info.InstallLocation) {
                if (Test-AppRoot $info.InstallLocation) { return $info.InstallLocation }
            }
        }
    }

    foreach ($cand in @(
            (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
            (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness'),
            (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness'),
            'C:\Program Files\DeepSeek Harness'
        )) {
        if (Test-AppRoot $cand) { return $cand }
    }

    throw '找不到 DSH Desktop 的安装目录（该目录下应有 DeepSeek Harness.exe 与 resources\app.asar）。请用 -AppRoot "安装目录" 指定。'
}

# 找到能用的 node：显式参数 → DSH 自带的运行时 → 常见安装位置 → PATH
function Find-Node {
    param([string]$Explicit = '')
    if ($Explicit -ne '' -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    $candidates = @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        'C:\Program Files\nodejs\node.exe'
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    throw 'node.exe 未找到。DSH Desktop 通常自带一份（在 ~\.dsh\dsh-runtimes 下）；也可以用 -Node 指定，或安装 Node.js。'
}