# =====================================================================
# 111/server.ps1  ·  跨境售后 AI 话术助手 · 本地演示服务
# 零依赖：只用 .NET 标准库（TcpListener），无需 Python / Node / 管理员权限
# 启动：双击 启动.bat   或   powershell -ExecutionPolicy Bypass -File server.ps1
# =====================================================================

param(
  [int]$Port = 8799,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root     = $PSScriptRoot
$WebDir   = Join-Path $Root 'web'
$DataDir  = Join-Path $Root 'data'
$LogDir   = Join-Path $Root 'logs'
$TmpDir   = Join-Path $LogDir 'tmp'
foreach ($d in @($LogDir, $TmpDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

# ---------------------------------------------------------------------
# 加载引擎
# ---------------------------------------------------------------------
. (Join-Path $Root 'engine\rules.ps1')
. (Join-Path $Root 'engine\ocr.ps1')
. (Join-Path $Root 'engine\reader.ps1')
. (Join-Path $Root 'engine\llm.ps1')
. (Join-Path $Root 'engine\pipeline.ps1')

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  汉正街跨境售后 AI 话术助手 · 本地演示" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

$counts = Initialize-KnowledgeBase -DataDir $DataDir
Write-Host ("  知识库加载完成：合规规则 {0} 条 / 术语 {1} 条 / 政策 {2} 条 / 意图标签 {3} 类" -f `
  $counts.compliance_rules, $counts.glossary, $counts.policy_index, $counts.intent_taxonomy) -ForegroundColor Green

$llmInfo = Initialize-Llm -Root $Root

$ocrLangs = @(Get-OcrAvailableLanguages)
if ($ocrLangs.Count -gt 0) {
  Write-Host ("  Windows OCR 可用语言：" + ($ocrLangs -join ', ')) -ForegroundColor Green
} else {
  Write-Host "  ⚠ 未检测到 Windows OCR 语言包，读屏功能不可用（可改用剪贴板或窗口直读）" -ForegroundColor Yellow
}

# 读取方式可用性自检
$uiaOk = $false
try { $null = Get-UiaWindows; $uiaOk = $true } catch {}
Write-Host ("  UI Automation 窗口直读：" + $(if ($uiaOk) { '可用' } else { '不可用' })) -ForegroundColor $(if ($uiaOk) { 'Green' } else { 'Yellow' })
$clipOk = $false
try { $null = Get-ClipboardText; $clipOk = $true } catch {}
Write-Host ("  剪贴板监听：" + $(if ($clipOk) { '可用' } else { '不可用' })) -ForegroundColor $(if ($clipOk) { 'Green' } else { 'Yellow' })

if ($llmInfo.provider -eq 'local') {
  Write-Host "  模型：本地规则引擎（未接入外部模型）" -ForegroundColor Green
  Write-Host "        配置模型：复制 config.example.json 为 config.local.json 并改 provider" -ForegroundColor DarkGray
} else {
  Write-Host ("  模型：{0} / key {1}" -f $llmInfo.provider, $(if ($llmInfo.has_key) { '已配置' } else { '未配置（将回退本地规则）' })) `
    -ForegroundColor $(if ($llmInfo.has_key) { 'Green' } else { 'Yellow' })
  Write-Host ("        密钥存储：" + $llmInfo.store_path) -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------
# HTTP 工具
# ---------------------------------------------------------------------
$script:MimeMap = @{
  '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'
  '.js'='application/javascript; charset=utf-8'; '.json'='application/json; charset=utf-8'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'
  '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.txt'='text/plain; charset=utf-8'
}

function Read-HttpRequest {
  param([System.Net.Sockets.NetworkStream]$Stream)
  $ms  = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 16384
  $headerEnd = -1

  while ($headerEnd -lt 0) {
    $n = $Stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
    $arr = $ms.ToArray()
    for ($i = 0; $i -le $arr.Length - 4; $i++) {
      if ($arr[$i] -eq 13 -and $arr[$i+1] -eq 10 -and $arr[$i+2] -eq 13 -and $arr[$i+3] -eq 10) { $headerEnd = $i; break }
    }
    if ($ms.Length -gt 32MB) { break }
  }
  if ($headerEnd -lt 0) { return $null }

  $all = $ms.ToArray()
  $headerText = [System.Text.Encoding]::UTF8.GetString($all, 0, $headerEnd)
  $lines = $headerText -split "`r`n"
  $requestLine = $lines[0]
  $parts = $requestLine -split ' '
  if ($parts.Count -lt 2) { return $null }
  $method = $parts[0]
  $path   = $parts[1]

  $headers = @{}
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $idx = $lines[$i].IndexOf(':')
    if ($idx -gt 0) {
      $k = $lines[$i].Substring(0, $idx).Trim().ToLower()
      $v = $lines[$i].Substring($idx+1).Trim()
      $headers[$k] = $v
    }
  }

  $bodyStart = $headerEnd + 4
  $bodyBytes = New-Object System.Collections.Generic.List[byte]
  if ($all.Length -gt $bodyStart) {
    for ($i = $bodyStart; $i -lt $all.Length; $i++) { $bodyBytes.Add($all[$i]) }
  }
  $contentLength = 0
  if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$contentLength) }
  while ($bodyBytes.Count -lt $contentLength) {
    $n = $Stream.Read($buf, 0, [math]::Min($buf.Length, $contentLength - $bodyBytes.Count))
    if ($n -le 0) { break }
    for ($i = 0; $i -lt $n; $i++) { $bodyBytes.Add($buf[$i]) }
  }

  $query = ''
  $qi = $path.IndexOf('?')
  if ($qi -ge 0) { $query = $path.Substring($qi+1); $path = $path.Substring(0, $qi) }

  return [pscustomobject]@{
    method  = $method
    path    = $path
    query   = $query
    headers = $headers
    body    = $bodyBytes.ToArray()
  }
}

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$Status = 200,
    [string]$ContentType = 'application/json; charset=utf-8',
    [byte[]]$Body = (New-Object byte[] 0),
    [string]$ExtraHeaders = ''
  )
  $statusText = switch ($Status) {
    200 { 'OK' } 400 { 'Bad Request' } 404 { 'Not Found' } 500 { 'Internal Server Error' }
    default { 'OK' }
  }
  $head = "HTTP/1.1 $Status $statusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nCache-Control: no-store`r`n$ExtraHeaders`r`n"
  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($headBytes, 0, $headBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

function Send-Json {
  param([System.Net.Sockets.NetworkStream]$Stream, $Object, [int]$Status = 200)
  $json = $Object | ConvertTo-Json -Depth 12 -Compress
  Send-Response -Stream $Stream -Status $Status -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
}

function Send-Text {
  param([System.Net.Sockets.NetworkStream]$Stream, [string]$Text, [string]$ContentType = 'text/plain; charset=utf-8', [int]$Status = 200)
  Send-Response -Stream $Stream -Status $Status -ContentType $ContentType -Body ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Get-BodyJson {
  param($Request)
  if ($Request.body.Length -eq 0) { return $null }
  $text = [System.Text.Encoding]::UTF8.GetString($Request.body)
  try { return $text | ConvertFrom-Json } catch { return $null }
}

function Get-BodyRawString {
  param($Request)
  if ($Request.body.Length -eq 0) { return '' }
  return [System.Text.Encoding]::UTF8.GetString($Request.body)
}

# ---------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------
function Handle-Request {
  param($Request, [System.Net.Sockets.NetworkStream]$Stream)

  $path = $Request.path

  if ($Request.method -eq 'OPTIONS') { Send-Response -Stream $Stream -Status 200; return }

  # ---------- API ----------
  if ($path -eq '/api/health') {
    Send-Json -Stream $Stream -Object @{
      ok = $true
      mode = (Get-ModelStatus).mode
      data = $counts
      ocr_languages = $ocrLangs
      uia_available = $uiaOk
      clipboard_available = $clipOk
      model = (Get-ModelStatus)
      port = $Port
    }
    return
  }

  # 列出可见窗口（供 UI Automation 直读选择目标）
  if ($path -eq '/api/windows' -and $Request.method -eq 'GET') {
    try {
      Send-Json -Stream $Stream -Object @{ ok = $true; windows = @(Get-UiaWindows) }
    } catch {
      Send-Json -Stream $Stream -Object @{ ok = $false; error = $_.Exception.Message } -Status 500
    }
    return
  }

  # UI Automation 直读指定窗口的文本（不走 OCR，直接拿文字）
  if ($path -eq '/api/uia' -and $Request.method -eq 'POST') {
    $b = Get-BodyJson -Request $Request
    $title = ''; $index = 0
    if ($null -ne $b) {
      if ($b.PSObject.Properties.Name -contains 'title') { $title = [string]$b.title }
      if ($b.PSObject.Properties.Name -contains 'index') { $index = [int]$b.index }
    }
    try {
      $r = Get-UiaWindowText -Title $title -Index $index
      Send-Json -Stream $Stream -Object @{ ok = $true; read = $r }
    } catch {
      Send-Json -Stream $Stream -Object @{ ok = $false; error = (Protect-Secret $_.Exception.Message) } -Status 200
    }
    return
  }

  # 剪贴板读取
  if ($path -eq '/api/clipboard' -and $Request.method -eq 'GET') {
    try {
      $t = Get-ClipboardText
      Send-Json -Stream $Stream -Object @{ ok = $true; text = $t; char_count = $t.Length }
    } catch {
      Send-Json -Stream $Stream -Object @{ ok = $false; error = $_.Exception.Message } -Status 500
    }
    return
  }

  # 模型状态（只返回 has_key，绝不返回密钥本身）
  if ($path -eq '/api/model-status' -and $Request.method -eq 'GET') {
    Send-Json -Stream $Stream -Object @{ ok = $true; model = (Get-ModelStatus) }
    return
  }

  if ($path -eq '/api/analyze' -and $Request.method -eq 'POST') {
    $b = Get-BodyJson -Request $Request
    if ($null -eq $b) { Send-Json -Stream $Stream -Object @{ ok=$false; error='请求体不是合法 JSON' } -Status 400; return }
    $text = [string]$b.text
    if ([string]::IsNullOrWhiteSpace($text)) { Send-Json -Stream $Stream -Object @{ ok=$false; error='text 不能为空' } -Status 400; return }
    $country = 'UNKNOWN'; if ($b.PSObject.Properties.Name -contains 'country') { $country = [string]$b.country }
    $platform = 'unknown'; if ($b.PSObject.Properties.Name -contains 'platform') { $platform = [string]$b.platform }
    $category = 'unknown'; if ($b.PSObject.Properties.Name -contains 'category') { $category = [string]$b.category }
    try {
      $r = Invoke-Pipeline -Text $text -Country $country -Platform $platform -Category $category -Source 'text'
      Write-Host ("  [分析] {0} | {1} | {2} | {3}ms" -f $country, $r.analysis.primary_intent, $r.escalation.need_human, $r.meta.latency_ms) -ForegroundColor DarkGray
      Send-Json -Stream $Stream -Object @{ ok=$true; result=$r }
    } catch {
      Send-Json -Stream $Stream -Object @{ ok=$false; error=$_.Exception.Message } -Status 500
    }
    return
  }

  if ($path -eq '/api/ocr' -and $Request.method -eq 'POST') {
    $b = Get-BodyJson -Request $Request
    if ($null -eq $b) { Send-Json -Stream $Stream -Object @{ ok=$false; error='请求体不是合法 JSON' } -Status 400; return }
    $img = [string]$b.image
    if ([string]::IsNullOrWhiteSpace($img)) { Send-Json -Stream $Stream -Object @{ ok=$false; error='image 不能为空' } -Status 400; return }
    $img = $img -replace '^data:image/[a-zA-Z]+;base64,', ''
    $country = 'UNKNOWN'; if ($b.PSObject.Properties.Name -contains 'country') { $country = [string]$b.country }
    $platform = 'unknown'; if ($b.PSObject.Properties.Name -contains 'platform') { $platform = [string]$b.platform }
    $category = 'unknown'; if ($b.PSObject.Properties.Name -contains 'category') { $category = [string]$b.category }
    $forceLang = ''; if ($b.PSObject.Properties.Name -contains 'ocrLanguage') { $forceLang = [string]$b.ocrLanguage }

    $tmpFile = Join-Path $TmpDir ("shot_" + [guid]::NewGuid().ToString('N') + ".png")
    try {
      [System.IO.File]::WriteAllBytes($tmpFile, [Convert]::FromBase64String($img))
      $ocr = Invoke-ScreenOcr -ImagePath $tmpFile -Languages @('en-US','zh-Hans-CN') -ForceLanguage $forceLang
      if ([string]::IsNullOrWhiteSpace($ocr.text)) {
        Send-Json -Stream $Stream -Object @{ ok=$false; error='未从图片中识别到文字'; ocr=$ocr } -Status 200
        return
      }
      $r = Invoke-Pipeline -Text $ocr.text -Country $country -Platform $platform -Category $category -Source 'screenshot' -OcrLanguage $ocr.language_used
      Write-Host ("  [读屏] {0} 字 / {1} | {2} | {3}ms" -f $ocr.char_count, $ocr.language_used, $r.analysis.primary_intent, $r.meta.latency_ms) -ForegroundColor DarkGray
      Send-Json -Stream $Stream -Object @{ ok=$true; ocr=$ocr; result=$r }
    } catch {
      Send-Json -Stream $Stream -Object @{ ok=$false; error=$_.Exception.Message } -Status 500
    } finally {
      try { if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force } } catch {}
    }
    return
  }

  if ($path -eq '/api/feedback' -and $Request.method -eq 'POST') {
    $b = Get-BodyJson -Request $Request
    $line = @{
      ts        = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      trace_id  = [string]$b.trace_id
      action    = [string]$b.action
      style     = [string]$b.style
      candidate_id = [string]$b.candidate_id
      intent    = [string]$b.intent
      country   = [string]$b.country
      final_text= [string]$b.final_text
    }
    $jsonLine = ($line | ConvertTo-Json -Depth 5 -Compress)
    $logFile = Join-Path $LogDir 'qa_logs.jsonl'
    [System.IO.File]::AppendAllText($logFile, $jsonLine + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  [反馈] {0} / {1} / {2}" -f $line.action, $line.style, $line.intent) -ForegroundColor DarkGray
    Send-Json -Stream $Stream -Object @{ ok=$true }
    return
  }

  if ($path -eq '/api/stats' -and $Request.method -eq 'GET') {
    $logFile = Join-Path $LogDir 'qa_logs.jsonl'
    $rows = @()
    if (Test-Path $logFile) {
      foreach ($l in (Get-Content $logFile -Encoding UTF8)) {
        if ([string]::IsNullOrWhiteSpace($l)) { continue }
        try { $rows += ($l | ConvertFrom-Json) } catch {}
      }
    }
    $byAction = @{}
    $byStyle = @{}
    foreach ($r in $rows) {
      if (-not $byAction.ContainsKey($r.action)) { $byAction[$r.action] = 0 }
      $byAction[$r.action]++
      if ($r.style) { if (-not $byStyle.ContainsKey($r.style)) { $byStyle[$r.style] = 0 }; $byStyle[$r.style]++ }
    }
    $total = $rows.Count
    $acc = 0; if ($byAction.ContainsKey('accept')) { $acc = $byAction['accept'] }
    $edit = 0; if ($byAction.ContainsKey('edit')) { $edit = $byAction['edit'] }
    $rate = 0; if ($total -gt 0) { $rate = [math]::Round(($acc + $edit) / $total, 3) }
    Send-Json -Stream $Stream -Object @{ ok=$true; total=$total; by_action=$byAction; by_style=$byStyle; accept_rate=$rate }
    return
  }

  # ---------- 静态文件 ----------
  $rel = $path.TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
  $rel = $rel -replace '/', '\'
  $full = Join-Path $WebDir $rel
  $resolved = $null
  try { $resolved = [System.IO.Path]::GetFullPath($full) } catch { $resolved = $null }

  if ($null -eq $resolved -or -not $resolved.StartsWith([System.IO.Path]::GetFullPath($WebDir))) {
    Send-Text -Stream $Stream -Text '403 Forbidden' -Status 403; return
  }
  if (-not (Test-Path $resolved -PathType Leaf)) {
    Send-Text -Stream $Stream -Text '404 Not Found' -Status 404; return
  }

  $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
  $ctype = 'application/octet-stream'
  if ($script:MimeMap.ContainsKey($ext)) { $ctype = $script:MimeMap[$ext] }
  $bytes = [System.IO.File]::ReadAllBytes($resolved)
  Send-Response -Stream $Stream -Status 200 -ContentType $ctype -Body $bytes
}

# ---------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------
function Test-PortFree {
  param([int]$P)
  $l = $null
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $P)
    $l.Start(); $l.Stop(); return $true
  } catch {
    if ($l) { try { $l.Stop() } catch {} }
    return $false
  }
}

function Test-IsOurServer {
  param([int]$P)
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$P/api/health" -TimeoutSec 3
    return ($r.ok -eq $true)
  } catch { return $false }
}

# 端口被占时分三种情况处理，不再直接报错退出
if (-not (Test-PortFree -P $Port)) {
  if (Test-IsOurServer -P $Port) {
    Write-Host ""
    Write-Host ("  端口 {0} 上已经有一个本服务在运行。" -f $Port) -ForegroundColor Yellow
    Write-Host ("  直接打开 →  http://127.0.0.1:{0}/" -f $Port) -ForegroundColor Green
    Write-Host "  （如需重启：先关掉原来那个窗口，或换个端口启动）" -ForegroundColor DarkGray
    if (-not $NoBrowser) { try { Start-Process ("http://127.0.0.1:{0}/" -f $Port) | Out-Null } catch {} }
    Start-Sleep -Seconds 2
    exit 0
  }
  # 端口被别的程序占用 → 自动向后找一个空闲端口
  $found = 0
  for ($p = $Port + 1; $p -le $Port + 20; $p++) {
    if (Test-PortFree -P $p) { $found = $p; break }
  }
  if ($found -eq 0) {
    Write-Host ("  端口 {0}~{1} 全部被占用，无法启动。" -f $Port, ($Port + 20)) -ForegroundColor Red
    Write-Host "  请手动指定： powershell -ExecutionPolicy Bypass -File server.ps1 -Port 9000" -ForegroundColor Yellow
    exit 1
  }
  Write-Host ""
  Write-Host ("  端口 {0} 已被其他程序占用，自动改用 {1}" -f $Port, $found) -ForegroundColor Yellow
  $Port = $found
}

$listener = $null
try {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  Write-Host ("  端口 $Port 启动失败：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host "  请改用其他端口： powershell -ExecutionPolicy Bypass -File server.ps1 -Port 9000" -ForegroundColor Yellow
  exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "  服务已启动 →  $url" -ForegroundColor Green
Write-Host "  停止服务：在本窗口按 Ctrl+C" -ForegroundColor DarkGray
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $NoBrowser) { try { Start-Process $url | Out-Null } catch {} }

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 30000
    $client.SendTimeout    = 30000
    $stream = $null
    try {
      $stream = $client.GetStream()
      $req = Read-HttpRequest -Stream $stream
      if ($null -ne $req) { Handle-Request -Request $req -Stream $stream }
    } catch {
      Write-Host ("  请求处理异常：" + $_.Exception.Message) -ForegroundColor DarkYellow
    } finally {
      try { if ($stream) { $stream.Close() } } catch {}
      try { $client.Close() } catch {}
    }
  }
} finally {
  if ($listener) { try { $listener.Stop() } catch {} }
  Write-Host ""
  Write-Host "  服务已停止。" -ForegroundColor Yellow
}
