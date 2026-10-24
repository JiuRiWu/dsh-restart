@echo off
rem dsh-restart shell patch - launcher for apply-on-exit.ps1
rem
rem Started by the scheduled task "dsh-restart-apply-on-exit" so that it stays
rem alive after DeepSeek Harness exits. Safe to run by hand as well.
rem
rem NOTE: deliberately ASCII-only. cmd.exe reads .cmd files in the OEM code page,
rem so non-ASCII comments here would be decoded differently than the .ps1 beside it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-on-exit.ps1" %*