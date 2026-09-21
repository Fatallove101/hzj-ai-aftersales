# =====================================================================
# hzj-ai-aftersales/tools/start-demo.ps1
# 「启动演示页面.bat」实际干活的地方。
#
# 为什么要拆成两层：
#   .bat 必须写成**纯 ASCII**。cmd.exe 读 .bat 时用的是系统 OEM 代码页
#   （中文 Windows 上是 GBK），UTF-8 的中文会被按 GBK 解码，
#   多字节序列会**把后面命令的首字符一起吞掉** —— 实测过：
#       'art' is not recognized...       ← "start" 被吃了 s
#       'nPolicy' is not recognized...   ← "-NoProfile" 被吃了 "-NoP"
#       '服务起来要点时间，延迟' is not recognized...  ← rem 注释变成了命令
#   脚本直接跑不起来。
#
#   PowerShell 脚本不一样：**带 UTF-8 BOM** 就能正确读中文，所以提示信息写在这里。
# =====================================================================
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host '    模拟客服页 · 扩展测试台' -ForegroundColor Cyan
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '    这个页面是「假装的客服后台」—— 不是产品本体。' -ForegroundColor Gray
Write-Host '    它用来测扩展读得准不准，因为真实客服后台需要账号才能进。' -ForegroundColor Gray
Write-Host ''
Write-Host '    启动后会自动打开：' -NoNewline
Write-Host ' http://127.0.0.1:8799/mock.html' -ForegroundColor Green
Write-Host ''
Write-Host '    用法：' -ForegroundColor White
Write-Host '      1. 页面打开后，扩展侧边栏会自己出来（这个页面已加进自动注入列表）' -ForegroundColor Gray
Write-Host '         如果没出来，点一下浏览器右上角的扩展图标。' -ForegroundColor DarkGray
Write-Host '      2. 读取源选「页面」→ 点「换一批」' -ForegroundColor Gray
Write-Host '      3. 读不到就点页脚 ⌖ 拾取一次「消息区」容器' -ForegroundColor Gray
Write-Host '      4. 满意的话点「⤵ 插入输入框」，文字会进页面底部的输入框' -ForegroundColor Gray
Write-Host ''
Write-Host '    服务窗口不要关，关了页面就用不了。' -ForegroundColor Yellow
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '    正在启动本地服务…' -ForegroundColor DarkGray
Write-Host ''

# server.ps1 自己会在**监听成功之后**打开浏览器（见它第 832/846 行），
# 所以这里不需要再搞什么"延迟几秒打开"，交给它就行。
& (Join-Path $Root 'server.ps1') -Port 8799 -OpenPath '/mock.html'

Write-Host ''
Write-Host '  服务已停止。' -ForegroundColor Yellow
