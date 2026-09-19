# =====================================================================
# hzj-ai-aftersales/engine/llm.ps1
# 模型接口层 —— 预留接入位，当前默认走本地回退（不发起任何外部请求）
#
# 【API Key 安全设计】这是本文件的核心，四条约束：
#   1. 密钥用 Windows DPAPI 加密后存在 %APPDATA%\hzj-agent\ 下，
#      不在仓库里、不在项目目录里、不进 git。
#   2. DPAPI 用 CurrentUser 作用域 —— 把密文文件拷到别的电脑或别的 Windows
#      账号下也解不开，等于废纸。
#   3. 密钥永远不出现在任何 HTTP 响应里。前端只能拿到 has_key: true/false。
#   4. 密钥永远不进日志。所有对外输出都过 Protect-Secret 做掩码。
#
# 【接入方式】改 config.local.json 的 provider 为 qianfan，并用
#   tools\set-api-key.ps1 存一次密钥即可。pipeline.ps1 一行都不用改。
# =====================================================================

Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue

$script:LocalConfigPath = $null   # 由 Initialize-Llm 设置

# 强制走本地规则引擎（不真调模型）。
# 为什么需要：tools\selfcheck.ps1 会跑完整管线（7 个行为用例），
# 一旦配了模型就会真发 7 次请求 —— 实测 227 秒、花钱、且输出不确定。
# **测试必须确定性、免费、快**，所以自检默认打开它。
$script:ForceLocal = $false
$script:LlmRoot  = $null          # 由 Initialize-Llm 设置
$script:CredFile = $null          # 由 Resolve-CredFile 解析
$script:CredResolved = $false

# 密钥存放位置候选（按优先级尝试）：
#   1. %APPDATA%\hzj-agent        标准位置
#   2. %LOCALAPPDATA%\hzj-agent   漫游配置不可写时
#   3. <项目>\.secrets            上面都不可写时（已被 .gitignore 忽略）
# 无论落在哪，密钥都是 DPAPI 加密的，且都不会进仓库。
function Resolve-CredFile {
  if ($script:CredResolved -and $script:CredFile) { return $script:CredFile }
  $cands = @()
  if ($env:APPDATA)      { $cands += (Join-Path $env:APPDATA      'hzj-agent') }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'hzj-agent') }
  if ($script:LlmRoot)   { $cands += (Join-Path $script:LlmRoot   '.secrets') }
  if ($cands.Count -eq 0) { $cands += (Join-Path $env:TEMP 'hzj-agent') }

  foreach ($d in $cands) {
    try {
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force -ErrorAction Stop | Out-Null }
      $probe = Join-Path $d '.wtest'
      [System.IO.File]::WriteAllText($probe, 'x')
      Remove-Item $probe -Force -ErrorAction SilentlyContinue
      $script:CredFile = Join-Path $d 'credential.dat'
      $script:CredResolved = $true
      return $script:CredFile
    } catch { continue }
  }
  # 全部不可写：返回首选路径，让上层表现为"未配置"，而不是直接崩
  $script:CredFile = Join-Path $cands[0] 'credential.dat'
  $script:CredResolved = $true
  return $script:CredFile
}

# ---------------------------------------------------------------------
# 密钥掩码：任何要打印/返回的内容都先过这里
# ---------------------------------------------------------------------
function Protect-Secret {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $key = Get-ApiKey -Quiet
  if ([string]::IsNullOrEmpty($key)) { return $Text }
  if ($Text.Contains($key)) { return $Text.Replace($key, '***MASKED***') }
  # 也屏蔽形如 Bearer xxx / 长 token 的片段
  $Text = [regex]::Replace($Text, '(?i)(bearer\s+)[A-Za-z0-9\-\._~\+/]{12,}', '$1***MASKED***')
  $Text = [regex]::Replace($Text, '(?i)("?(?:api[_-]?key|access[_-]?token|secret[_-]?key)"?\s*[:=]\s*"?)[A-Za-z0-9\-\._~\+/]{12,}', '$1***MASKED***')
  return $Text
}

# ---------------------------------------------------------------------
# 密钥存取（DPAPI）
# ---------------------------------------------------------------------
function Set-ApiKey {
  param([Parameter(Mandatory)][string]$Key)
  [void](Resolve-CredFile)
  $plain = [System.Text.Encoding]::UTF8.GetBytes($Key)
  $cipher = [System.Security.Cryptography.ProtectedData]::Protect(
    $plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.IO.File]::WriteAllBytes($script:CredFile, $cipher)
  [Array]::Clear($plain, 0, $plain.Length)
  return $true
}

function Get-ApiKey {
  param([switch]$Quiet)
  [void](Resolve-CredFile)
  if (-not (Test-Path $script:CredFile)) { return $null }
  try {
    $cipher = [System.IO.File]::ReadAllBytes($script:CredFile)
    $plain  = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($plain)
  } catch {
    if (-not $Quiet) { Write-Warning ("密钥解密失败（可能换了 Windows 账号或文件被改）：" + $_.Exception.Message) }
    return $null
  }
}

function Remove-ApiKey {
  [void](Resolve-CredFile)
  if (Test-Path $script:CredFile) { Remove-Item $script:CredFile -Force; return $true }
  return $false
}

function Test-ApiKeyConfigured {
  [void](Resolve-CredFile)
  if (-not (Test-Path $script:CredFile)) { return $false }
  $k = Get-ApiKey -Quiet
  return (-not [string]::IsNullOrEmpty($k))
}

function Get-ApiKeyMeta {
  # 只返回"元信息"，绝不返回密钥本身
  [void](Resolve-CredFile)
  if (-not (Test-Path $script:CredFile)) {
    return [pscustomobject]@{ configured = $false; updated_at = $null; fingerprint = $null; store = $script:CredFile }
  }
  $k = Get-ApiKey -Quiet
  if ([string]::IsNullOrEmpty($k)) {
    return [pscustomobject]@{ configured = $false; updated_at = $null; fingerprint = $null; store = $script:CredFile; error = 'decrypt_failed' }
  }
  # 指纹：只暴露前 4 位 + 长度，用于确认"是不是我存的那把"，不足以还原密钥
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($k))
  $fp = ([System.BitConverter]::ToString($hash) -replace '-','').Substring(0,8)
  return [pscustomobject]@{
    configured  = $true
    updated_at  = (Get-Item $script:CredFile).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    fingerprint = $fp
    length      = $k.Length
    store       = $script:CredFile
  }
}

# ---------------------------------------------------------------------
# 模型配置（非密钥部分放在项目内 config.local.json，已被 .gitignore 忽略）
# ---------------------------------------------------------------------
# 打开/关闭「强制本地」。自检脚本用，正常服务不碰它。
function Set-LlmForceLocal {
  param([bool]$On = $true)
  $script:ForceLocal = $On
}
function Get-ModelConfig {
  $default = [pscustomobject]@{
    provider = 'local'                 # local | qianfan
    endpoint = ''
    model    = ''
    timeout  = 30
  }
  if ($script:ForceLocal) {
    $default.provider = 'local'
    $default.endpoint = ''
    $default.model    = ''
    return $default
  }
  if ([string]::IsNullOrWhiteSpace($script:LocalConfigPath)) { return $default }
  if (-not (Test-Path $script:LocalConfigPath)) { return $default }
  try {
    $cfg = Get-Content $script:LocalConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $m = $cfg.model
    if ($null -eq $m) { return $default }
    if ($m.PSObject.Properties.Name -contains 'provider' -and $m.provider) { $default.provider = [string]$m.provider }
    if ($m.PSObject.Properties.Name -contains 'endpoint' -and $m.endpoint) { $default.endpoint = [string]$m.endpoint }
    if ($m.PSObject.Properties.Name -contains 'model'    -and $m.model)    { $default.model    = [string]$m.model }
    if ($m.PSObject.Properties.Name -contains 'timeout'  -and $m.timeout)  { $default.timeout  = [int]$m.timeout }
  } catch {}
  return $default
}

# 写入模型配置（供界面保存用）。只改传入的字段，其余保持原值。
# 注意：**API Key 不写在这里** —— 它单独走 DPAPI 加密存储，永远不落明文配置文件。
function Set-ModelConfig {
  param(
    [string]$Provider,
    [string]$Endpoint,
    [string]$Model,
    [int]$Timeout = 0
  )
  $cur = Get-ModelConfig
  if (-not [string]::IsNullOrWhiteSpace($Provider)) { $cur.provider = $Provider }
  if (-not [string]::IsNullOrWhiteSpace($Endpoint)) { $cur.endpoint = $Endpoint }
  if (-not [string]::IsNullOrWhiteSpace($Model))    { $cur.model    = $Model }
  if ($Timeout -gt 0) { $cur.timeout = $Timeout }

  $obj = [ordered]@{
    model = [ordered]@{
      provider = $cur.provider
      endpoint = $cur.endpoint
      model    = $cur.model
      timeout  = $cur.timeout
    }
  }
  $json = $obj | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($script:LocalConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $cur
}

function Initialize-Llm {
  param([Parameter(Mandatory)][string]$Root)
  $script:LlmRoot = $Root
  $script:LocalConfigPath = Join-Path $Root 'config.local.json'
  [void](Resolve-CredFile)
  return [pscustomobject]@{
    provider   = (Get-ModelConfig).provider
    has_key    = (Test-ApiKeyConfigured)
    store_path = $script:CredFile
  }
}

# ---------------------------------------------------------------------
# 读取 Agent 系统提示词
#   直接从 prompts\*.md 里抽第一个 ```text 代码块 —— 单一真源，
#   提示词只维护一份，改 md 这里自动跟着变，不会出现两套提示词漂移。
# ---------------------------------------------------------------------
function Get-AgentPrompt {
  param([Parameter(Mandatory)]
        [ValidateSet('orchestrator','translate','intent','rewrite','generate','compliance','dataloop')]
        [string]$Name)
  if ([string]::IsNullOrWhiteSpace($script:LlmRoot)) { return '' }
  $map = @{
    orchestrator = '00-主控Agent-系统提示词.md'
    translate    = '01-翻译Agent-系统提示词.md'
    intent       = '02-意图情绪Agent-系统提示词.md'
    rewrite      = '03-查询改写Agent-系统提示词.md'
    generate     = '04-话术生成Agent-系统提示词.md'
    compliance   = '05-合规校验Agent-系统提示词.md'
    dataloop     = '06-数据闭环Agent-系统提示词.md'
  }
  $file = Join-Path (Join-Path $script:LlmRoot 'prompts') $map[$Name]
  if (-not (Test-Path $file)) { return '' }
  $txt = Get-Content $file -Raw -Encoding UTF8
  $m = [regex]::Match($txt, '(?s)```text\s*(.*?)```')
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ''
}

# 把提示词里的 {{变量}} 占位符替换成实际值
function Expand-AgentPrompt {
  param([Parameter(Mandatory)][string]$Prompt, [Parameter(Mandatory)][hashtable]$Vars)
  $out = $Prompt
  foreach ($k in $Vars.Keys) {
    $v = [string]$Vars[$k]
    $out = $out.Replace('{{' + $k + '}}', $v)
  }
  return $out
}

# ---------------------------------------------------------------------
# 统一的模型调用入口
#   返回 $null 表示"用本地回退"，调用方据此继续走规则版，链路不会断
# ---------------------------------------------------------------------
function Invoke-LLM {
  param(
    [Parameter(Mandatory)][ValidateSet('translate','intent','rewrite','generate','compliance')][string]$Task,
    [Parameter(Mandatory)][hashtable]$Params
  )
  $cfg = Get-ModelConfig
  if ($cfg.provider -eq 'local') { return $null }
  if ([string]::IsNullOrWhiteSpace($cfg.endpoint)) {
    Write-Warning "provider=$($cfg.provider) 但未配置 endpoint，回退到本地规则"
    return $null
  }
  if (-not (Test-ApiKeyConfigured)) {
    Write-Warning "provider=$($cfg.provider) 但未配置 API Key（运行 tools\set-api-key.ps1），回退到本地规则"
    return $null
  }
  try {
    return Invoke-ChatCompletion -Task $Task -Params $Params -Config $cfg
  } catch {
    # 把 URL 和状态码一并写出来。
    # 之前只报 "The remote server returned an error: (404) Not Found"，
    # 完全看不出是 endpoint 少拼了 /chat/completions（排查绕了很久）。
    $u = Resolve-ChatUrl -Endpoint $cfg.endpoint
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $detail = $detail + ' | ' + $_.ErrorDetails.Message
    }
    Write-Warning (Protect-Secret ("模型调用失败（$u）：" + $detail + "  → 回退到本地规则"))
    return $null
  }
}

# ---------------------------------------------------------------------
# 通用 Chat Completions 适配器
#
# ⚠️ 重要：下列请求/响应字段名按 OpenAI 兼容格式编写。
#    接入千帆时**必须**先跑一次 DryRun 看清实际请求体，再对照控制台
#    「应用发布」页给出的示例核对字段名与鉴权方式，不要直接照搬上线。
#
#    tools\test-model.ps1 -DryRun   ← 只打印请求形状，不发请求、不打印密钥
# ---------------------------------------------------------------------
function Build-ChatRequest {
  param([string]$Task, [hashtable]$Params, $Config)
  $systemPrompt = ''
  $userContent  = ''
  switch ($Task) {
    'translate'  { $systemPrompt = $Params['system_prompt']; $userContent = [string]$Params['text'] }
    'intent'     { $systemPrompt = $Params['system_prompt']; $userContent = [string]$Params['text'] }
    'rewrite'    { $systemPrompt = $Params['system_prompt']; $userContent = [string]$Params['text'] }
    'generate'   { $systemPrompt = $Params['system_prompt']; $userContent = [string]$Params['context'] }
    'compliance' { $systemPrompt = $Params['system_prompt']; $userContent = [string]$Params['text'] }
  }
  $body = @{
    model = $Config.model
    messages = @(
      @{ role = 'system'; content = $systemPrompt },
      @{ role = 'user';   content = $userContent }
    )
    temperature = $(if ($Params.ContainsKey('temperature')) { [double]$Params['temperature'] } else { 0.2 })
    stream = $false
  }
  return ($body | ConvertTo-Json -Depth 8)
}

# ---------------------------------------------------------------------
# 把配置里的 endpoint 归一化成真正的"对话补全"地址。
#
# 为什么需要：配置里通常只填基址（https://qianfan.baidubce.com/v2），
# 但真正要 POST 的是 .../v2/chat/completions。
# 原来直接拿基址去 POST，千帆返回 404 ResourceNotFound ——
# 而 Invoke-LLM 的 catch 把它降级成"本地模板"，界面上完全看不出是 URL 错了。
# 现在基址和完整路径都能填，代码里统一补齐。
# ---------------------------------------------------------------------
function Resolve-ChatUrl {
  param([string]$Endpoint)
  $u = ([string]$Endpoint).Trim().TrimEnd('/')
  if ([string]::IsNullOrWhiteSpace($u)) { return $u }
  if ($u -match '/(chat/completions|completions|responses|messages)$') { return $u }
  return $u + '/chat/completions'
}
# ---------------------------------------------------------------------
# 稳健地把模型返回的文本解析成对象。
#
# 为什么需要：提示词里明确写了"只输出 JSON、不要用 markdown 代码块包裹"，
# 但真实模型（实测千帆 ernie-4.5-turbo-128k）**照样会裹一层 ```json**。
# 原来的判断是"第一个字符必须是 {"，遇到代码块就直接放弃 →
# 翻译拿不到 translated_text、生成拿不到 candidates，
# 全链路静默降级成本地模板（界面上完全看不出是解析失败）。
# 所以这里做三层兜底：剥代码块 → 提取首个 JSON 块 → 直接尝试解析。
# ---------------------------------------------------------------------
function ConvertFrom-ModelJson {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $t = $Text.Trim()

  # ① 剥掉 ```json ... ``` / ``` ... ``` 包裹
  if ($t.StartsWith('```')) {
    $t = $t -replace '^```[a-zA-Z]*\s*', ''
    $t = $t -replace '\s*```\s*$', ''
    $t = $t.Trim()
  }

  # ② 已经是 JSON 就直接解析
  if ($t.StartsWith('{') -or $t.StartsWith('[')) {
    try { return ($t | ConvertFrom-Json) } catch { }
  }

  # ③ 前后还有废话：截取第一段 { ... } 或 [ ... ]（按括号配对找结尾）
  $startObj = $t.IndexOf('{')
  $startArr = $t.IndexOf('[')
  $start = -1; $open = ''; $close = ''
  if ($startObj -ge 0 -and ($startArr -lt 0 -or $startObj -lt $startArr)) { $start = $startObj; $open = '{'; $close = '}' }
  elseif ($startArr -ge 0) { $start = $startArr; $open = '['; $close = ']' }
  if ($start -lt 0) { return $null }

  $depth = 0; $inStr = $false; $esc = $false
  for ($i = $start; $i -lt $t.Length; $i++) {
    $ch = $t[$i]
    if ($esc) { $esc = $false; continue }
    if ($ch -eq '\') { if ($inStr) { $esc = $true }; continue }
    if ($ch -eq '"') { $inStr = -not $inStr; continue }
    if ($inStr) { continue }
    if ($ch -eq $open)  { $depth++ }
    elseif ($ch -eq $close) {
      $depth--
      if ($depth -eq 0) {
        $cand = $t.Substring($start, $i - $start + 1)
        try { return ($cand | ConvertFrom-Json) } catch { return $null }
      }
    }
  }
  return $null
}
function Invoke-ChatCompletion {
  param([string]$Task, [hashtable]$Params, $Config)

  $json  = Build-ChatRequest -Task $Task -Params $Params -Config $Config
  $key   = Get-ApiKey -Quiet
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

  $headers = @{
    'Content-Type'  = 'application/json; charset=utf-8'
    'Authorization' = "Bearer $key"
  }

  $url = Resolve-ChatUrl -Endpoint $Config.endpoint
  $resp = Invoke-RestMethod -Uri $url -Method POST -Headers $headers `
            -Body $bytes -TimeoutSec $Config.timeout

  # 兼容两种常见返回结构
  $content = $null
  if ($resp.PSObject.Properties.Name -contains 'choices' -and $resp.choices.Count -gt 0) {
    $content = $resp.choices[0].message.content
  } elseif ($resp.PSObject.Properties.Name -contains 'result') {
    $content = $resp.result
  }
  if ([string]::IsNullOrWhiteSpace($content)) { throw '模型返回内容为空或结构不符合预期' }

  # 若上游返回 JSON，尝试解析成对象（带代码块兜底，见 ConvertFrom-ModelJson）
  $parsed = ConvertFrom-ModelJson -Text $content
  if ($null -ne $parsed) { return $parsed }
  return $content
}

# ---------------------------------------------------------------------
# 组装翻译 Agent 的系统提示词（把 {{变量}} 真正展开）
#
# 为什么要这个：Expand-AgentPrompt 早就写好了，但管线里从来没用过 ——
# 直接把带 {{raw_text}} / {{direction}} 的原文丢给模型。
# 模型能猜出大意，但**方向**（target2zh 还是 zh2target）猜错就会把
# 中文再翻成中文。回译功能必须靠它。
# ---------------------------------------------------------------------
function Build-TranslatePrompt {
  param(
    [Parameter(Mandatory)][ValidateSet('target2zh','zh2target')][string]$Direction,
    [Parameter(Mandatory)][string]$RawText,
    [string]$SourceLang = 'auto',
    [string]$TargetLang = 'zh',
    [string]$GlossaryJson = '[]',
    [string]$ContextTurns = ''
  )
  $p = Get-AgentPrompt -Name 'translate'
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  return (Expand-AgentPrompt -Prompt $p -Vars @{
    direction     = $Direction
    raw_text      = $RawText
    source_lang   = $SourceLang
    target_lang   = $TargetLang
    glossary_json = $(if ([string]::IsNullOrWhiteSpace($GlossaryJson)) { '[]' } else { $GlossaryJson })
    context_turns = $ContextTurns
  })
}
function Get-ModelStatus {
  $cfg = Get-ModelConfig
  $meta = Get-ApiKeyMeta
  return [pscustomobject]@{
    provider        = $cfg.provider
    endpoint_set    = (-not [string]::IsNullOrWhiteSpace($cfg.endpoint))
    model           = $cfg.model
    has_key         = $meta.configured
    key_fingerprint = $meta.fingerprint
    key_updated_at  = $meta.updated_at
    key_store       = $meta.store
    mode            = $(if ($cfg.provider -eq 'local' -or -not $meta.configured) { 'local-fallback' } else { 'model' })
  }
}
