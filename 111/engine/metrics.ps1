# =====================================================================
# 111/engine/metrics.ps1
# 质量度量：人工修改幅度
#
# 为什么用"修改幅度"而不是只用"采纳率"：
#   采纳率只能区分"用/不用"，但"修改后采纳"里改一个字和重写一遍是完全
#   不同的两件事。修改幅度 = 建议话术与坐席最终发出内容的相似度，
#   它直接反映"建议准不准"，是迭代话术模板时最该盯的指标。
# =====================================================================

# 归一化编辑距离相似度：1.0 = 完全一致，0.0 = 完全不同
# 为避免超长文本把 CPU 打满，超过 400 字时截断比较（差异本身就够大，不影响结论）
function Get-TextSimilarity {
  param([string]$A, [string]$B)

  $a = [string]$A; $b = [string]$B
  if ([string]::IsNullOrWhiteSpace($a) -and [string]::IsNullOrWhiteSpace($b)) { return 1.0 }
  if ([string]::IsNullOrWhiteSpace($a) -or  [string]::IsNullOrWhiteSpace($b)) { return 0.0 }

  # 先做归一化：去掉空白差异，否则"换行 vs 空格"会被算成改动
  $norm = { param($s) ($s -replace '\s+', ' ').Trim() }
  $a = & $norm $a; $b = & $norm $b

  if ($a.Length -gt 400) { $a = $a.Substring(0, 400) }
  if ($b.Length -gt 400) { $b = $b.Substring(0, 400) }
  if ($a -eq $b) { return 1.0 }

  $n = $a.Length; $m = $b.Length
  # 滚动数组版 Levenshtein，内存 O(m)
  $prev = New-Object int[] ($m + 1)
  $cur  = New-Object int[] ($m + 1)
  for ($j = 0; $j -le $m; $j++) { $prev[$j] = $j }

  for ($i = 1; $i -le $n; $i++) {
    $cur[0] = $i
    $ca = $a[$i - 1]
    for ($j = 1; $j -le $m; $j++) {
      $cost = if ($ca -eq $b[$j - 1]) { 0 } else { 1 }
      $del = $prev[$j] + 1
      $ins = $cur[$j - 1] + 1
      $sub = $prev[$j - 1] + $cost
      $min = $del
      if ($ins -lt $min) { $min = $ins }
      if ($sub -lt $min) { $min = $sub }
      $cur[$j] = $min
    }
    $tmp = $prev; $prev = $cur; $cur = $tmp
  }
  $dist = $prev[$m]
  $maxLen = [math]::Max($n, $m)
  if ($maxLen -eq 0) { return 1.0 }
  $sim = 1.0 - ($dist / [double]$maxLen)
  if ($sim -lt 0) { $sim = 0.0 }
  return [math]::Round($sim, 4)
}

# 把相似度翻译成人看得懂的结论
function Get-EditVerdict {
  param([double]$Similarity)
  if ($Similarity -ge 0.95) { return '几乎照用' }
  if ($Similarity -ge 0.80) { return '小幅润色' }
  if ($Similarity -ge 0.55) { return '明显改写' }
  if ($Similarity -ge 0.25) { return '大幅重写' }
  return '完全没用'
}
