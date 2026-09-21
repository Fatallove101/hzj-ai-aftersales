@echo off
chcp 65001 >nul
title 模拟客服页 · 扩展测试台
cd /d "%~dp0"

echo.
echo   ================================================================
echo     模拟客服页 · 扩展测试台
echo   ================================================================
echo.
echo     这个页面是「假装的客服后台」——不是产品本体。
echo     它用来测扩展读得准不准，因为真实客服后台需要账号才能进。
echo.
echo     启动后会自动打开： http://127.0.0.1:8799/mock.html
echo.
echo     用法：
echo       1. 页面打开后，点浏览器右上角的扩展图标
echo          （这个页面不在自动注入列表里，要点一下图标手动注入）
echo       2. 侧边栏出来以后，读取源选「页面」→ 点「换一批」
echo       3. 读不到就点页脚 ⌖ 拾取一次「消息区」容器
echo       4. 满意的话点「⤵ 插入输入框」，文字会进页面底部的输入框
echo.
echo     服务窗口不要关，关了页面就用不了。
echo   ================================================================
echo.

rem 服务起来要点时间，延迟 4 秒再开页面（和 server.ps1 里的自动打开不重复：
rem 这里用 -NoBrowser，由本脚本自己负责开）
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" http://127.0.0.1:8799/mock.html"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 8799 -NoBrowser

echo.
echo   服务已停止。按任意键关闭本窗口。
pause >nul
