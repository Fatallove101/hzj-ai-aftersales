# =====================================================================
# hzj-ai-aftersales/tools/mock-selftest.ps1
# 模拟页自检：用扩展**真实的提取代码**去跑 web\mock.html，看能不能读对。
#
# 为什么需要它：
#   web\mock.html 是给人看的"假客服后台"，但它必须能被扩展读对。
#   只靠肉眼看页面长得像不像，证明不了扩展读得到 ——
#   比如说话人线索如果写在 class 上，扩展的 signature() 就会把
#   三种消息当成三种不同结构，只读到数量最多的那一组（实测踩过）。
#
# 做法：把 mock.html 的 DOM + 扩展的 lib\util.js + lib\extract.js
#       拼成一个临时页面，在无头 Edge 里真跑一遍 extractConversation()，
#       把结果写进 DOM，再用 --dump-dom 抓回来。
#
# 用法： powershell -ExecutionPolicy Bypass -File tools\mock-selftest.ps1
# =====================================================================
$ErrorActionPreference = 'Continue'
$Root  = Split-Path -Parent $PSScriptRoot
$noBom = New-Object System.Text.UTF8Encoding($false)

$mockPath = Join-Path $Root 'web\mock.html'
$utilPath = Join-Path $Root 'extension\lib\util.js'
$exPath   = Join-Path $Root 'extension\lib\extract.js'

foreach ($p in @($mockPath, $utilPath, $exPath)) {
  if (-not (Test-Path $p)) { Write-Host ("  找不到: " + $p) -ForegroundColor Red; exit 1 }
}

Write-Host ''
Write-Host '==================== 模拟页自检 ====================' -ForegroundColor Cyan
Write-Host ''

$mock  = [System.IO.File]::ReadAllText($mockPath, $noBom)
$util  = [System.IO.File]::ReadAllText($utilPath, $noBom)
$ex    = [System.IO.File]::ReadAllText($exPath, $noBom)

# 注入：扩展的两个库 + 一段跑提取并把结果写进 DOM 的脚本
$probe = @'
<script>
(function () {
  var out = { ok: false, err: '', method: '', count: 0, sides: [], texts: [], inputFound: false };
  try {
    if (typeof AIH === 'undefined') { out.err = 'AIH 未加载'; }
    else {
      // 路径 A：自动识别（启发式）
      var r = AIH.extractConversation({ selectors: null });
      out.method = r.method;
      out.count  = r.messages.length;
      out.sides  = r.messages.map(function (m) { return m.side; });
      out.texts  = r.messages.map(function (m) { return m.text.slice(0, 34); });
      var box = AIH.findInputBox();
      out.inputFound = !!box;

      // 路径 B：用户用 ⌖ 拾取过消息区（选择器优先于启发式）
      var r2 = AIH.extractConversation({ selectors: { messageList: '#msgList' } });
      out.pickMethod = r2.method;
      out.pickCount  = r2.messages.length;
      out.pickSides  = r2.messages.map(function (m) { return m.side; });

      out.ok = true;
    }
  } catch (e) { out.err = (e && e.message) || String(e); }
  var pre = document.createElement('pre');
  pre.id = 'SELFTEST_JSON';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>
'@

$page = $mock.Replace('</body>', "<script>`n$util`n</script>`n<script>`n$ex`n</script>`n$probe`n</body>")
$tmp  = Join-Path $env:TEMP ('mock_selftest_' + [guid]::NewGuid().ToString('N') + '.html')
[System.IO.File]::WriteAllText($tmp, $page, (New-Object System.Text.UTF8Encoding($true)))

# 找 Edge
$edge = $null
foreach ($c in @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)) { if (Test-Path $c) { $edge = $c; break } }
if (-not $edge) { Write-Host '  找不到 Edge，跳过（这个检查只在本机有 Edge 时能跑）' -ForegroundColor Yellow; Remove-Item $tmp -Force; exit 2 }
Write-Host ("  浏览器: " + $edge)

$dump = Join-Path $env:TEMP ('mock_dump_' + [guid]::NewGuid().ToString('N') + '.txt')
$prof = Join-Path $env:TEMP ('edge_prof_' + [guid]::NewGuid().ToString('N'))

# 输出重定向到文件 —— 不用管道（沙箱下管道抓子进程输出会 EPERM）
$args = @(
  '--headless=new', '--disable-gpu', '--no-sandbox',
  "--user-data-dir=$prof",
  '--window-size=1400,1000',
  '--virtual-time-budget=5000',
  '--dump-dom',
  ('file:///' + ($tmp -replace '\\', '/'))
)
$p = Start-Process -FilePath $edge -ArgumentList $args -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $dump -RedirectStandardError (Join-Path $env:TEMP 'edge_err.txt')
Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue

$html = ''
if (Test-Path $dump) { $html = [System.IO.File]::ReadAllText($dump) }
Remove-Item $dump -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:TEMP 'edge_err.txt') -Force -ErrorAction SilentlyContinue

$m = [regex]::Match($html, '(?s)<pre id="SELFTEST_JSON">(.*?)</pre>')
if (-not $m.Success) {
  Write-Host '  x 拿不到提取结果（页面可能没跑起来）' -ForegroundColor Red
  exit 1
}
# HTML 实体还原
$json = $m.Groups[1].Value.Replace('&quot;', '"').Replace('&amp;', '&').Replace('&lt;', '<').Replace('&gt;', '>')
$r = $json | ConvertFrom-Json

Write-Host ''
Write-Host ("  提取方式   : " + $r.method)
Write-Host ("  读到消息数 : " + $r.count)
Write-Host ("  说话人     : " + ($r.sides -join ', '))
Write-Host ("  找到输入框 : " + $r.inputFound)
Write-Host ''
Write-Host ("  --- 拾取路径（用户用 ⌖ 选过消息区）---")
Write-Host ("  提取方式   : " + $r.pickMethod + "   ← 应该是 adapter")
Write-Host ("  读到消息数 : " + $r.pickCount)
Write-Host ("  说话人     : " + ($r.pickSides -join ', '))
Write-Host ''
Write-Host '  逐条文本：'
$i = 0
foreach ($t in $r.texts) {
  Write-Host ("    [{0}] {1}  {2}" -f $i, $r.sides[$i], $t)
  $i++
}

# ---------------- 断言 ----------------
Write-Host ''
$fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { Write-Host ("  OK  " + $name) -ForegroundColor Green }
  else { Write-Host ("  x   " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}

Assert '提取没报错'        ($r.ok -eq $true) $r.err
Assert '读到 4 条消息'     ($r.count -eq 4) ("实际 " + $r.count + " 条 —— 少了就说明 signature() 把三种消息当成不同结构，只读了数量最多的那组")
Assert '识别到客户'        ($r.sides -contains 'buyer') '没有任何一条被识别为客户'
Assert '识别到 AI客服'     (($r.sides | Where-Object { $_ -eq 'unknown' }).Count -ge 1) 'AI客服应落到 unknown（面板显示为 AI客服）'
Assert '识别到人工客服'    ($r.sides -contains 'seller') '没有任何一条被识别为人工客服'
Assert '找到回复输入框'    ($r.inputFound -eq $true) 'insert 功能会不可用'
Assert '拾取后走 adapter'  ($r.pickMethod -eq 'adapter') ("实际 " + $r.pickMethod + " —— 拾取的选择器必须优先于启发式")
Assert '拾取后读全 4 条'   ($r.pickCount -eq 4) ("实际 " + $r.pickCount)

Write-Host ''
Write-Host '===================================================' -ForegroundColor Cyan
if ($fail -eq 0) { Write-Host '  模拟页自检通过' -ForegroundColor Green }
else { Write-Host ("  模拟页自检失败 " + $fail + " 项") -ForegroundColor Red }
Write-Host ''
exit $fail
