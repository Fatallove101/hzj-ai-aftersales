# =====================================================================
# 111/engine/reader.ps1
# 对话读取层 —— 比 OCR 更好的三种方式
#
#   方式          准确率   速度    需要用户操作        适用
#   ────────────────────────────────────────────────────────────
#   UI Automation  100%    快      选一次窗口          桌面客户端 / 部分网页
#   剪贴板监听     100%    最快    Ctrl+C 复制一次     任何软件（最通用）
#   OCR 读屏       约 95%   中      选一次窗口          兜底：任何看得见的东西
#
# 前两种拿到的**是文字本身**，不是图片，所以没有识别误差、也不消耗视觉模型额度。
# =====================================================================

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes  -ErrorAction SilentlyContinue

[void][System.Windows.Automation.AutomationElement]
[void][System.Windows.Automation.ControlType]
[void][System.Windows.Automation.TreeWalker]

# ---------------------------------------------------------------------
# 列出可见的顶层窗口
# ---------------------------------------------------------------------
function Get-UiaWindows {
  $result = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window)
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $i = 0
    foreach ($w in $wins) {
      $i++
      $title = $w.Current.Name
      if ([string]::IsNullOrWhiteSpace($title)) { continue }
      $proc = ''
      try { $proc = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
      $result += [pscustomobject]@{ index = $i; title = $title; process = $proc; pid = $w.Current.ProcessId }
    }
  } catch {}
  return $result
}

# ---------------------------------------------------------------------
# 文本清洗：去重相邻重复、去掉纯符号、压缩空白
# ---------------------------------------------------------------------
function Clean-TextLines {
  param([string[]]$Lines)
  $out = New-Object System.Collections.ArrayList
  $prev = $null
  foreach ($l in $Lines) {
    if ($null -eq $l) { continue }
    $t = ($l -replace '\s+', ' ').Trim()
    if ($t.Length -lt 2) { continue }
    if ($t -match '^[\p{P}\p{S}\s]+$') { continue }        # 纯标点/符号
    if ($t -eq $prev) { continue }                          # 相邻重复
    [void]$out.Add($t)
    $prev = $t
  }
  return $out
}

# ---------------------------------------------------------------------
# 遍历一棵 UIA 子树抽文本
# ---------------------------------------------------------------------
function Get-UiaSubtreeText {
  param($Element, [int]$MaxNodes = 6000, [int]$MaxMs = 8000)
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $queue  = New-Object System.Collections.Queue
  $queue.Enqueue($Element)
  $nodes = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $lines = New-Object System.Collections.ArrayList

  while ($queue.Count -gt 0 -and $nodes -lt $MaxNodes -and $sw.ElapsedMilliseconds -lt $MaxMs) {
    $el = $queue.Dequeue(); $nodes++
    try {
      $nm = $el.Current.Name
      if (-not [string]::IsNullOrWhiteSpace($nm)) { [void]$lines.Add($nm) }
      $c = $walker.GetFirstChild($el)
      while ($null -ne $c) { $queue.Enqueue($c); $c = $walker.GetNextSibling($c) }
    } catch {}
  }
  $sw.Stop()
  return [pscustomobject]@{ lines = $lines; nodes = $nodes; ms = $sw.ElapsedMilliseconds; truncated = ($nodes -ge $MaxNodes) }
}

# ---------------------------------------------------------------------
# 从指定窗口读取文本
#   策略：优先只读「文档区」（浏览器的网页正文 / 客户端的会话区），
#         这样能自动避开浏览器工具栏那堆无关文字；找不到再退化为整窗遍历。
# ---------------------------------------------------------------------
function Get-UiaWindowText {
  param(
    [string]$Title = '',
    [int]$Index = 0,
    [int]$MaxNodes = 6000,
    [int]$MaxMs = 8000
  )
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

  $target = $null
  if (-not [string]::IsNullOrWhiteSpace($Title)) {
    foreach ($w in $wins) { if ($w.Current.Name -like "*$Title*") { $target = $w; break } }
  }
  if ($null -eq $target -and $Index -gt 0 -and $Index -le $wins.Count) { $target = $wins.Item($Index - 1) }
  if ($null -eq $target) { throw "找不到标题包含「$Title」的窗口" }

  # ① 先找文档区（网页正文）
  $docCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document)
  $docs = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)

  $allLines = New-Object System.Collections.ArrayList
  $nodes = 0; $ms = 0; $truncated = $false
  $scope = 'window'

  if ($docs.Count -gt 0) {
    $scope = 'document'
    foreach ($d in $docs) {
      $r = Get-UiaSubtreeText -Element $d -MaxNodes $MaxNodes -MaxMs $MaxMs
      $nodes += $r.nodes; $ms += $r.ms
      if ($r.truncated) { $truncated = $true }
      foreach ($l in $r.lines) { [void]$allLines.Add($l) }
      if ($ms -gt $MaxMs) { break }
    }
  } else {
    $r = Get-UiaSubtreeText -Element $target -MaxNodes $MaxNodes -MaxMs $MaxMs
    $nodes = $r.nodes; $ms = $r.ms; $truncated = $r.truncated
    foreach ($l in $r.lines) { [void]$allLines.Add($l) }
  }

  $clean = Clean-TextLines -Lines $allLines

  return [pscustomobject]@{
    window_title = $target.Current.Name
    scope        = $scope                 # document=只读了正文区；window=整窗
    lines        = $clean
    text         = ($clean -join "`n")
    line_count   = $clean.Count
    char_count   = (($clean -join "`n")).Length
    nodes        = $nodes
    ms           = $ms
    truncated    = $truncated
  }
}

# ---------------------------------------------------------------------
# 剪贴板读取（最通用：任何软件里选中文字按 Ctrl+C 即可）
# ---------------------------------------------------------------------
function Get-ClipboardText {
  $t = ''
  try {
    if (Get-Command Get-Clipboard -ErrorAction SilentlyContinue) {
      $t = (Get-Clipboard -Raw -ErrorAction Stop)
    } else {
      Add-Type -AssemblyName System.Windows.Forms
      $t = [System.Windows.Forms.Clipboard]::GetText()
    }
  } catch { $t = '' }
  if ($null -eq $t) { return '' }
  $t = $t -replace "`r`n", "`n"
  $t = $t -replace "`r", "`n"
  return $t.Trim()
}
