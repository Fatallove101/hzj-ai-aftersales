@echo off
chcp 65001 >nul
title Cross-border After-sales AI Assistant - Local Demo
cd /d "%~dp0"

echo.
echo   Starting local service ...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 8799

echo.
echo   Service stopped. Press any key to close.
pause >nul
