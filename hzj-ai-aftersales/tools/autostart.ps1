# =====================================================================
# hzj-ai-aftersales/tools/autostart.ps1
# 把本地服务装成「开机自启」，省掉每次手动双击 bat。
#
# 为什么需要它：
#   浏览器扩展在技术上**没法启动本机进程**，所以本地服务必须有人拉起来。
#   每次开机都要记得双击 bat，很容易忘 —— 忘了扩展就显示"连不上本地服务"。
#   装成开机自启之后，登录 Windows 时服务就在后台静默跑起来了，
#   打开任何网页 + 扩展都能直接连上。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\autostart.ps1            # 看当前状态
#   powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Install   # 装上
#   powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Uninstall # 卸掉
# =====================================================================
param(
  [switch]$Install,
  [switch]$Uninstall,
  [int]$Port = 8799
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot          # hzj-ai-aftersales\
$ServerPs1 = Join-Path $Root 'server.ps1'
$ShortcutName = '跨境销售AI话术助手-本地服务.lnk'
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir $ShortcutName

function Show-Status {
  Write-Host ''
  Write-Host '  本地服务 · 开机自启状态' -ForegroundColor Cyan
  Write-Host '  ------------------------------------------------------------'
  $installed = Test-Path $ShortcutPath
  Write-Host ('  自启快捷方式 : ' + $(if ($installed) { '已安装' } else { '未安装' })) -ForegroundColor $(if ($installed) { 'Green' } else { 'Yellow' })
  if ($installed) { Write-Host ('     位置      : ' + $ShortcutPath) -ForegroundColor DarkGray }

  $running = $false
  try {
    $h = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 3
    $running = ($h.ok -eq $true)
    if ($running) { Write-Host ('  服务当前状态 : 运行中（模型=' + $h.model.mode + '）') -ForegroundColor Green }
  } catch { }
  if (-not $running) { Write-Host '  服务当前状态 : 未运行' -ForegroundColor Yellow }

  Write-Host '  ------------------------------------------------------------'
  if (-not $installed) {
    Write-Host '  想省掉每次手动双击？执行：' -ForegroundColor White
    Write-Host '     powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Install' -ForegroundColor Gray
  } elseif (-not $running) {
    Write-Host '  已经装了自启，但这次登录还没生效（或已被手动关掉）。' -ForegroundColor White
    Write-Host '  现在就能拉起：双击项目里的 启动演示页面.bat 或 启动网页（推荐用扩展，详见README）.bat' -ForegroundColor Gray
  }
  Write-Host ''
}

if ($Uninstall) {
  if (Test-Path $ShortcutPath) {
    Remove-Item $ShortcutPath -Force
    Write-Host ''
    Write-Host '  已卸载开机自启。' -ForegroundColor Green
    Write-Host ('  删除的快捷方式：' + $ShortcutPath) -ForegroundColor DarkGray
    Write-Host ''
  } else {
    Write-Host ''
    Write-Host '  本来就没装，无需卸载。' -ForegroundColor Yellow
    Write-Host ''
  }
  exit 0
}

if ($Install) {
  if (-not (Test-Path $ServerPs1)) {
    Write-Host ('  找不到 server.ps1：' + $ServerPs1) -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Path $StartupDir)) {
    New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null
  }

  # 目标命令：静默起服务，且**不自动打开浏览器**
  # （开机时自己弹个浏览器窗口很烦；要看页面自己双击 bat）
  $target = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $argsLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ServerPs1 + '" -Port ' + $Port + ' -NoBrowser'

  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($ShortcutPath)
  $lnk.TargetPath = $target
  $lnk.Arguments = $argsLine
  $lnk.WorkingDirectory = $Root
  $lnk.WindowStyle = 7          # 7 = 最小化，配合 -WindowStyle Hidden 基本看不到窗口
  $lnk.Description = '跨境销售 AI 话术助手 · 本地服务（开机自启）'
  $lnk.Save()

  Write-Host ''
  Write-Host '  已安装开机自启。' -ForegroundColor Green
  Write-Host ('  快捷方式：' + $ShortcutPath) -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  生效时机：下次登录 Windows 时自动在后台启动。' -ForegroundColor White
  Write-Host '  现在想立刻用：双击 启动演示页面.bat，或直接跑 tools\autostart.ps1 看状态。' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  不想要了就执行： powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Uninstall' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

Show-Status
