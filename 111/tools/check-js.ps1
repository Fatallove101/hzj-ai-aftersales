# =====================================================================
# 111/tools/check-js.ps1
# 浏览器扩展 JS 结构校验器
#
# 为什么需要它：这台机器没有 Node，headless 浏览器又被沙箱挡住（Chromium 的
# IPC 需要命名管道），所以没法用真正的 JS 引擎做语法检查。
# 这个脚本用状态机把 JS 过一遍，能抓出：
#   · 括号/方括号/花括号不配对
#   · 字符串、模板字符串、块注释未闭合
#   · 正则字面量未闭合
# 抓不出类型/语义错误，但手写大文件时最常见的低级错误都能拦住。
#
# 用法： powershell -ExecutionPolicy Bypass -File tools\check-js.ps1
# =====================================================================

param([string]$Dir)

$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = Split-Path -Parent $PSScriptRoot }
$extDir = Join-Path $Dir 'extension'
if (-not (Test-Path $extDir)) { $extDir = $Dir }

function Test-JsSource {
  param([string]$Path)

  $src = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
  $n = $src.Length
  $problems = New-Object System.Collections.ArrayList

  $stack = New-Object System.Collections.ArrayList
  $line = 1
  $i = 0
  $prevSig = ''          # 上一个有意义的代码字符（用于判断 / 是正则还是除号）
  $prevWord = ''         # 上一个标识符（用于 return / typeof 等）

  $openOf = @{ ')' = '('; ']' = '['; '}' = '{' }
  $nameOf = @{ '(' = '圆括号'; '[' = '方括号'; '{' = '花括号' }

  while ($i -lt $n) {
    $c = $src[$i]

    if ($c -eq "`n") { $line++; $i++; continue }

    # ---------- 行注释 ----------
    if ($c -eq '/' -and ($i + 1) -lt $n -and $src[$i+1] -eq '/') {
      while ($i -lt $n -and $src[$i] -ne "`n") { $i++ }
      continue
    }

    # ---------- 块注释 ----------
    if ($c -eq '/' -and ($i + 1) -lt $n -and $src[$i+1] -eq '*') {
      $startLine = $line
      $i += 2
      $closed = $false
      while ($i -lt $n) {
        if ($src[$i] -eq "`n") { $line++ }
        if ($src[$i] -eq '*' -and ($i + 1) -lt $n -and $src[$i+1] -eq '/') { $i += 2; $closed = $true; break }
        $i++
      }
      if (-not $closed) { [void]$problems.Add("行 $startLine : 块注释 /* 未闭合") }
      continue
    }

    # ---------- 单/双引号字符串 ----------
    if ($c -eq "'" -or $c -eq '"') {
      $quote = $c
      $startLine = $line
      $i++
      $closed = $false
      while ($i -lt $n) {
        $ch = $src[$i]
        if ($ch -eq '\') { $i += 2; continue }
        if ($ch -eq "`n") { break }         # 普通字符串不能跨行
        if ($ch -eq $quote) { $i++; $closed = $true; break }
        $i++
      }
      if (-not $closed) { [void]$problems.Add("行 $startLine : 字符串 $quote 未闭合") }
      $prevSig = '"'; $prevWord = ''
      continue
    }

    # ---------- 模板字符串 ----------
    if ($c -eq '`') {
      $startLine = $line
      $i++
      $closed = $false
      $depth = 0
      while ($i -lt $n) {
        $ch = $src[$i]
        if ($ch -eq '\') { $i += 2; continue }
        if ($ch -eq "`n") { $line++ }
        if ($ch -eq '$' -and ($i+1) -lt $n -and $src[$i+1] -eq '{') { $depth++; $i += 2; continue }
        if ($ch -eq '}' -and $depth -gt 0) { $depth--; $i++; continue }
        if ($ch -eq '`' -and $depth -eq 0) { $i++; $closed = $true; break }
        $i++
      }
      if (-not $closed) { [void]$problems.Add("行 $startLine : 模板字符串 `` 未闭合") }
      $prevSig = '"'; $prevWord = ''
      continue
    }

    # ---------- 正则字面量 vs 除号 ----------
    if ($c -eq '/') {
      $isRegex = $false
      if ($prevSig -eq '' ) { $isRegex = $true }
      elseif ('(,=:[!&|?{};+-*%~^<>'.IndexOf($prevSig) -ge 0) { $isRegex = $true }
      elseif ($prevWord -match '^(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case)$') { $isRegex = $true }

      if ($isRegex) {
        $startLine = $line
        $i++
        $closed = $false
        $inClass = $false
        while ($i -lt $n) {
          $ch = $src[$i]
          if ($ch -eq '\') { $i += 2; continue }
          if ($ch -eq "`n") { break }
          if ($ch -eq '[') { $inClass = $true }
          elseif ($ch -eq ']') { $inClass = $false }
          elseif ($ch -eq '/' -and -not $inClass) { $i++; $closed = $true; break }
          $i++
        }
        if (-not $closed) { [void]$problems.Add("行 $startLine : 正则字面量未闭合") }
        # 跳过 flags
        while ($i -lt $n -and $src[$i] -match '[a-z]') { $i++ }
        $prevSig = '/'; $prevWord = ''
        continue
      }
      # 除号
      $prevSig = '/'; $prevWord = ''; $i++
      continue
    }

    # ---------- 括号配对 ----------
    if ($c -eq '(' -or $c -eq '[' -or $c -eq '{') {
      [void]$stack.Add(@{ ch = $c; line = $line })
      $prevSig = $c; $prevWord = ''; $i++
      continue
    }
    if ($c -eq ')' -or $c -eq ']' -or $c -eq '}') {
      # 注意：Hashtable 用 [char] 索引匹配不到 [string] 键，必须显式转字符串
      $want = $openOf[[string]$c]
      if ($stack.Count -eq 0) {
        [void]$problems.Add("行 $line : 多余的 '$c'（没有对应的开括号）")
      } else {
        $top = $stack[$stack.Count - 1]
        if ($top.ch -ne $want) {
          [void]$problems.Add("行 $line : '$c' 与第 $($top.line) 行的 '$($top.ch)' 不匹配")
          [void]$stack.RemoveAt($stack.Count - 1)
        } else {
          [void]$stack.RemoveAt($stack.Count - 1)
        }
      }
      $prevSig = $c; $prevWord = ''; $i++
      continue
    }

    # ---------- 空白 ----------
    if ($c -match '\s') { $i++; continue }

    # ---------- 标识符 ----------
    if ($c -match '[A-Za-z_$]') {
      $s = $i
      while ($i -lt $n -and $src[$i] -match '[A-Za-z0-9_$]') { $i++ }
      $prevWord = $src.Substring($s, $i - $s)
      $prevSig = 'a'
      continue
    }

    $prevSig = $c; $prevWord = ''; $i++
  }

  foreach ($s in $stack) {
    [void]$problems.Add("行 $($s.line) : '$($s.ch)' 未闭合（缺 $($nameOf[[string]$s.ch])）")
  }

  return [pscustomobject]@{ file = (Split-Path -Leaf $Path); problems = $problems }
}

# ---------------------------------------------------------------------
Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  JS 结构校验（无 Node 环境下的替代方案）" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

$files = Get-ChildItem -Recurse -Filter *.js $extDir | Sort-Object FullName
$total = 0
foreach ($f in $files) {
  $r = Test-JsSource -Path $f.FullName
  $rel = $f.FullName.Replace("$extDir\", '')
  if ($r.problems.Count -eq 0) {
    Write-Host ("  OK    {0}" -f $rel) -ForegroundColor Green
  } else {
    $total += $r.problems.Count
    Write-Host ("  ERR   {0}  ({1} 处)" -f $rel, $r.problems.Count) -ForegroundColor Red
    $r.problems | Select-Object -First 8 | ForEach-Object { Write-Host ("          " + $_) -ForegroundColor Yellow }
    if ($r.problems.Count -gt 8) { Write-Host ("          … 其余 " + ($r.problems.Count - 8) + " 处省略") -ForegroundColor DarkGray }
  }
}

# manifest 的字段引用检查：js 列表里的文件必须都存在
$mf = Join-Path $extDir 'manifest.json'
if (Test-Path $mf) {
  Write-Host ""
  Write-Host "  --- manifest.json 引用检查 ---" -ForegroundColor White
  $m = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json
  $missing = 0
  foreach ($js in $m.content_scripts[0].js) {
    if (Test-Path (Join-Path $extDir $js)) { Write-Host ("    OK    " + $js) -ForegroundColor Green }
    else { Write-Host ("    缺失  " + $js) -ForegroundColor Red; $missing++ }
  }
  foreach ($ic in $m.icons.PSObject.Properties) {
    if (-not (Test-Path (Join-Path $extDir $ic.Value))) { Write-Host ("    缺失  " + $ic.Value) -ForegroundColor Red; $missing++ }
  }
  if (Test-Path (Join-Path $extDir $m.background.service_worker)) { Write-Host ("    OK    " + $m.background.service_worker) -ForegroundColor Green }
  else { Write-Host ("    缺失  " + $m.background.service_worker) -ForegroundColor Red; $missing++ }
  $total += $missing
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
if ($total -eq 0) { Write-Host "  全部通过" -ForegroundColor Green }
else { Write-Host ("  发现 {0} 个问题" -f $total) -ForegroundColor Red }
Write-Host "==============================================" -ForegroundColor Cyan
exit $total
