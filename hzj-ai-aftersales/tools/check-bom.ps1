# =====================================================================
# hzj-ai-aftersales/tools/check-bom.ps1
# 检查所有 .ps1 / .json / .md 的编码是否符合要求
#
# 为什么需要它（这个坑我踩了 4 次）：
#   本项目在 PowerShell 5.1 下运行。5.1 **不会**自动识别无 BOM 的 UTF-8，
#   会按系统 ANSI（中文 Windows 上是 GBK）解码 —— 文件里的中文注释变成乱码，
#   进而破坏字符串引号配对，报出完全看不懂的语法错误，例如：
#       "Unexpected token '鎶€鑳藉姞杞藉畬鎴愶細'"
#
#   而用各种编辑器/工具写文件时 BOM 很容易被悄悄丢掉，
#   所以必须有一条自动检查，而不是靠人记得。
#
# 用法： powershell -File tools\check-bom.ps1
# 退出码：0 = 全部正常，1 = 有文件缺 BOM
# =====================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

$bad = @()
$checked = 0

# .json **绝对不能**带 BOM —— JSON.parse / ConvertFrom-Json 都会直接报错。
# 踩过的坑：改 extension\manifest.json 时用 $bom 写，结果 JSON.parse 报
#   SyntaxError: Unexpected token ''
# 扩展直接加载失败（而 .ps1 的检查抓不到这个，因为 json 不在检查范围里）。
# .bat **必须纯 ASCII**。
# 踩过的坑：启动演示页面.bat 里写了 UTF-8 中文，cmd.exe 按 GBK 解码，
# 多字节序列把**后面命令的首字符一起吞掉**，实测报错：
#     'art' is not recognized...       ← "start" 被吃了 s
#     'nPolicy' is not recognized...   ← "-NoProfile" 被吃了 "-NoP"
#     '服务起来要点时间，延迟' is not recognized...  ← rem 注释变成了命令
# 脚本直接跑不起来。中文提示请放到 .ps1（带 BOM）里，由 .bat 调用。
$batBad = @()
Get-ChildItem -Path $root -Recurse -Filter *.bat -File -ErrorAction SilentlyContinue | ForEach-Object {
  $bb = [System.IO.File]::ReadAllBytes($_.FullName)
  $na = 0
  for ($q = 0; $q -lt $bb.Length; $q++) { if ($bb[$q] -gt 127) { $na++ } }
  if ($na -gt 0) { $batBad += ($_.FullName.Replace($root + '\', '') + '  （' + $na + ' 个非 ASCII 字节）') }
}

$jsonBad = @()
Get-ChildItem -Path $root -Recurse -Filter *.json -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\logs\\' } | ForEach-Object {
    $b = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
      $jsonBad += $_.FullName.Replace($root + '\', '')
    }
  }

# .ps1 必须有 BOM（PS 5.1 按 ANSI 解码会乱码）
Get-ChildItem -Path $root -Recurse -Filter *.ps1 -File | ForEach-Object {
  $checked++
  $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if (-not $hasBom) { $bad += $_.FullName.Replace("$root\", '') }
}

Write-Host ''
Write-Host '=============================================='
Write-Host '  编码检查（BOM）'
Write-Host '=============================================='
Write-Host ("  检查 {0} 个 .ps1 文件" -f $checked)

if ($bad.Count -eq 0) {
Write-Host ('  .ps1 带 BOM: {0} 个' -f $checked) -NoNewline
if ($jsonBad.Count -eq 0) { Write-Host '   .json 无 BOM: 是' -ForegroundColor Green }
else { Write-Host ('   .json 无 BOM: 否（' + $jsonBad.Count + ' 个）') -ForegroundColor Red }
Write-Host ('  .bat 纯 ASCII: ' ) -NoNewline
if ($batBad.Count -eq 0) { Write-Host '是' -ForegroundColor Green } else { Write-Host ('否（' + $batBad.Count + ' 个）') -ForegroundColor Red }
  Write-Host '  ✓ 全部带 BOM' -ForegroundColor Green
  Write-Host ''
  if ($jsonBad.Count -gt 0) {
    Write-Host ''
    Write-Host '  ✕ 这些 .json 带了 BOM，会导致 JSON.parse / ConvertFrom-Json 直接失败：' -ForegroundColor Red
    foreach ($j in $jsonBad) { Write-Host ('      ' + $j) -ForegroundColor Red }
    Write-Host ''
    Write-Host '  修复：重新以「UTF-8 无 BOM」保存这些 json。' -ForegroundColor Yellow
    Write-Host ''
    exit 1
  }
  if ($batBad.Count -gt 0) {
    Write-Host ''
    Write-Host '  ✕ 这些 .bat 含非 ASCII 字符。cmd.exe 按 GBK 解码时会把后面命令的首字符吞掉：' -ForegroundColor Red
    Write-Host '     （实测：start 变 art、-NoProfile 变 nPolicy，脚本直接跑不起来）' -ForegroundColor DarkGray
    foreach ($x in $batBad) { Write-Host ('      ' + $x) -ForegroundColor Red }
    Write-Host ''
    Write-Host '  修复：.bat 只写英文；中文提示移到 .ps1（UTF-8 带 BOM）里，由 .bat 调用。' -ForegroundColor Yellow
    Write-Host ''
    exit 1
  }
  exit 0
}

Write-Host ("  ✕ {0} 个文件缺 BOM（PowerShell 5.1 会按 ANSI 解码，中文注释将变乱码并可能引发语法错误）：" -f $bad.Count) -ForegroundColor Red
foreach ($b in $bad) { Write-Host ("      " + $b) -ForegroundColor Red }
Write-Host ''
Write-Host '  修复：把这些文件重新以「UTF-8 带 BOM」保存。' -ForegroundColor Yellow
Write-Host '        在 PowerShell 里可执行：' -ForegroundColor Yellow
Write-Host '        $b=New-Object System.Text.UTF8Encoding($true)' -ForegroundColor DarkGray
Write-Host '        $t=[IO.File]::ReadAllText($p,(New-Object System.Text.UTF8Encoding($false)))' -ForegroundColor DarkGray
Write-Host '        [IO.File]::WriteAllText($p,$t,$b)' -ForegroundColor DarkGray
Write-Host ''
exit 1
