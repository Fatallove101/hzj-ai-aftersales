# =====================================================================
# hzj-ai-aftersales/tools/check-docs.ps1
# 文档引用检查：文档里写的项目内路径，是不是真的存在？
#
# 为什么需要它：
#   目录从 111 改名为 hzj-ai-aftersales、启动.bat 改成长名字这两次，
#   都留下了文档没跟着改的问题（README 里还写着 `cd 111`）。
#   这类"文档过期"不会报错、不会崩，只有人照着做才发现 —— 靠人眼盯不住。
#
# 用法： powershell -ExecutionPolicy Bypass -File tools\check-docs.ps1
# =====================================================================
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Repo = Split-Path -Parent $Root
$sep = [char]92
$noBom = New-Object System.Text.UTF8Encoding($false)

# 这些是**有意引用外部资源**，不是项目内路径，不算错
$external = @(
  'Eleven617/', 'akshaykokane/', 'app/skills/', 'auto/scroll',
  'commands/', 'chrome://', 'edge://', 'qianfan.baidubce.com'
)

$docs = @()
foreach ($d in @('README.md', 'CONTRIBUTING.md')) {
  $p = Join-Path $Repo $d
  if (Test-Path $p) { $docs += $p }
}
Get-ChildItem $Root -Recurse -Filter *.md -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\logs\\|\\samples\\' } |
  ForEach-Object { $docs += $_.FullName }
$docs = $docs | Sort-Object -Unique

Write-Host ''
Write-Host '==================== 文档引用检查 ====================' -ForegroundColor Cyan
Write-Host ("  扫描 {0} 个 Markdown 文件" -f $docs.Count)
Write-Host ''

$checked = 0
$missing = @()

foreach ($doc in $docs) {
  $txt = [System.IO.File]::ReadAllText($doc, $noBom)
  $docDir = Split-Path -Parent $doc

  # 反引号里形如 a/b 或 a\b 的相对路径
  $ms = [regex]::Matches($txt, '`([A-Za-z0-9_\u4e00-\u9fa5\.\-]+[/\\][A-Za-z0-9_\u4e00-\u9fa5\.\-/\\]+)`')
  $seen = @{}
  foreach ($m in $ms) {
    $rel = $m.Groups[1].Value
    if ($seen.ContainsKey($rel)) { continue }
    $seen[$rel] = 1

    # 过滤：URL / 通配符 / 占位符
    if ($rel -match '^https?:|^\*|\*$|<|>|\{|%') { continue }
    $skip = $false
    foreach ($e in $external) { if ($rel.StartsWith($e)) { $skip = $true; break } }
    if ($skip) { continue }

    $checked++
    # 依次在多个基准目录下找。为什么不只用一个：
    #   文档分布在仓库根、hzj-ai-aftersales\ 和 agent设计\ 三个位置，
    #   同一个 `engine/llm.ps1` 从根看是 hzj-ai-aftersales\engine\llm.ps1，
    #   从 hzj-ai-aftersales\ 看是 engine\llm.ps1。只用一个基准会满屏误报，
    #   误报多了这个检查就没人看了 —— 那就等于没有。
    $found = $false
    foreach ($base in @($Repo, $Root, (Join-Path $Repo 'agent设计'), $docDir)) {
      foreach ($cand in @((Join-Path $base $rel), (Join-Path $base ($rel -replace '/', $sep)))) {
        if (Test-Path $cand) { $found = $true; break }
      }
      if ($found) { break }
    }
    if ($found) { continue }

    $relDoc = $doc.Replace($Repo + $sep, '')
    $missing += ('{0}  引用 `{1}`' -f $relDoc, $rel)
  }
}

if ($missing.Count -eq 0) {
  Write-Host ("  OK  检查了 {0} 个路径引用，全部存在" -f $checked) -ForegroundColor Green
} else {
  Write-Host ("  x   检查了 {0} 个路径引用，有 {1} 个找不到：" -f $checked, $missing.Count) -ForegroundColor Red
  foreach ($x in $missing) { Write-Host ('        ' + $x) -ForegroundColor Red }
  Write-Host ''
  Write-Host '  提示：目录改名 / 文件改名后，文档里的引用最容易漏。' -ForegroundColor Yellow
  Write-Host '        确认是真过期就改文档；确认是外部引用就加进本脚本的 $external 白名单。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host ''
exit $(if ($missing.Count -eq 0) { 0 } else { 1 })
