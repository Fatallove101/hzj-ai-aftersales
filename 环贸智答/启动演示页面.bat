@echo off
chcp 65001 >nul
title Demo Page - Extension Test Bench
cd /d "%~dp0"

rem ===================================================================
rem  IMPORTANT: this .bat is PURE ASCII on purpose.
rem
rem  cmd.exe reads .bat files using the system OEM codepage (GBK on
rem  Chinese Windows). If this file contained UTF-8 Chinese, cmd would
rem  decode it as GBK, and the multi-byte sequences would SWALLOW the
rem  first characters of the following commands. Measured failures:
rem      'art' is not recognized...      <- "start" lost its "s"
rem      'nPolicy' is not recognized...  <- "-NoProfile" lost "-NoP"
rem  The script would not run at all.
rem
rem  So: keep this file ASCII-only. All Chinese messages live in
rem  tools\start-demo.ps1, which is UTF-8 *with BOM* and reads fine.
rem ===================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-demo.ps1"

echo.
echo   Service stopped. Press any key to close.
pause >nul
