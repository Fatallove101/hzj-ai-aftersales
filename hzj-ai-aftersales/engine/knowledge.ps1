# =====================================================================
# hzj-ai-aftersales/engine/knowledge.ps1
# 可插拔的知识源
#
# 为什么要有这一层：
#   现在知识来自本地 CSV（policy_index.csv）。你后续要接千帆知识库 /
#   千帆数据库（通过 MCP）。如果检索逻辑直接写死 Search-PolicyIndex，
#   接入时就得改管线 —— 那是错的地方。所以这里立一个统一的检索入口
#   Search-Knowledge，管线只认它，底层换供应商不影响管线。
#
# 对外契约（两个 provider 必须返回同样形状的证据对象）：
#   doc_id / title / snippet / score / country / platform / effective_date / source
#
# 设计原则（重要）：
#   千帆没配好时**回退到本地，并把降级原因明确写出来**，
#   绝不静默返回空 —— 静默失败在合规场景里等于隐藏风险。
# =====================================================================

$script:KnowledgeConfigPath = $null

# ---------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------
function Initialize-Knowledge {
  param([Parameter(Mandatory)][string]$Root)
  $script:KnowledgeConfigPath = Join-Path $Root 'config.local.json'
}

function Get-KnowledgeConfig {
  $def = [pscustomobject]@{
    provider        = 'local'          # local | qianfan
    qianfan_endpoint = ''              # MCP Server 或 AppBuilder 的检索端点
    qianfan_app_id   = ''              # 千帆 AppBuilder 应用 ID（可选）
    qianfan_dataset  = ''              # 知识库/数据集 ID（可选）
    qianfan_token    = ''              # 走 MCP 时的鉴权头（可选，通常不需要——见下方说明）
    timeout_ms       = 8000
    fallback_local   = $true           # 千帆失败时是否回退本地
  }
  if ([string]::IsNullOrWhiteSpace($script:KnowledgeConfigPath)) { return $def }
  if (-not (Test-Path $script:KnowledgeConfigPath)) { return $def }
  try {
    $cfg = Get-Content $script:KnowledgeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $cfg.knowledge) { return $def }
    $k = $cfg.knowledge
    foreach ($p in @('provider','qianfan_endpoint','qianfan_app_id','qianfan_dataset','qianfan_token')) {
      if ($k.PSObject.Properties.Name -contains $p -and $k.$p) { $def.$p = [string]$k.$p }
    }
    if ($k.PSObject.Properties.Name -contains 'timeout_ms' -and $k.timeout_ms) { $def.timeout_ms = [int]$k.timeout_ms }
    if ($k.PSObject.Properties.Name -contains 'fallback_local') { $def.fallback_local = [bool]$k.fallback_local }
  } catch { }
  return $def
}

function Set-KnowledgeConfig {
  param([hashtable]$Values)
  if ([string]::IsNullOrWhiteSpace($script:KnowledgeConfigPath)) { throw '知识源配置路径未初始化' }

  # 读整份配置，只替换 knowledge 段（不能把 model 段冲掉）
  $all = [ordered]@{}
  if (Test-Path $script:KnowledgeConfigPath) {
    try {
      $o = Get-Content $script:KnowledgeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($p in $o.PSObject.Properties.Name) { $all[$p] = $o.$p }
    } catch { }
  }
  $cur = Get-KnowledgeConfig
  $k = [ordered]@{
    provider         = $cur.provider
    qianfan_endpoint = $cur.qianfan_endpoint
    qianfan_app_id   = $cur.qianfan_app_id
    qianfan_dataset  = $cur.qianfan_dataset
    qianfan_token    = $cur.qianfan_token
    timeout_ms       = $cur.timeout_ms
    fallback_local   = $cur.fallback_local
  }
  foreach ($key in $Values.Keys) { if ($k.Contains($key)) { $k[$key] = $Values[$key] } }
  $all['knowledge'] = $k

  $json = ($all | ConvertTo-Json -Depth 6)
  [System.IO.File]::WriteAllText($script:KnowledgeConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $k
}

# ---------------------------------------------------------------------
# 状态：给界面和排查用
# ---------------------------------------------------------------------
function Get-KnowledgeProviderInfo {
  $cfg = Get-KnowledgeConfig
  $qianfanReady = (-not [string]::IsNullOrWhiteSpace($cfg.qianfan_endpoint))
  $localReady = @($script:PolicyIndex).Count -gt 0

  $active = 'local'
  $reason = ''
  if ($cfg.provider -eq 'qianfan') {
    if ($qianfanReady) { $active = 'qianfan' }
    else {
      $active = $(if ($cfg.fallback_local) { 'local' } else { 'none' })
      $reason = 'provider=qianfan 但未填写 qianfan_endpoint'
    }
  }

  return [pscustomobject]@{
    configured      = $cfg.provider
    active          = $active
    active_label    = $(switch ($active) { 'qianfan' { '千帆知识库' } 'local' { '本地 CSV 知识库' } default { '（无可用知识源）' } })
    degraded        = ($cfg.provider -ne $active)
    degrade_reason  = $reason
    local_ready     = $localReady
    local_count     = @($script:PolicyIndex).Count
    qianfan_ready   = $qianfanReady
    qianfan_endpoint = $cfg.qianfan_endpoint
    qianfan_app_id  = $cfg.qianfan_app_id
    qianfan_dataset = $cfg.qianfan_dataset
    fallback_local  = $cfg.fallback_local
    timeout_ms      = $cfg.timeout_ms
  }
}

# ---------------------------------------------------------------------
# 统一检索入口 —— 管线只认这一个
# ---------------------------------------------------------------------
function Search-Knowledge {
  param(
    [string]$Country = 'UNKNOWN',
    [string]$Platform = 'unknown',
    [string[]]$Keywords = @(),
    [int]$TopK = 4
  )
  $cfg = Get-KnowledgeConfig

  if ($cfg.provider -eq 'qianfan' -and -not [string]::IsNullOrWhiteSpace($cfg.qianfan_endpoint)) {
    try {
      $rows = Search-KnowledgeQianfan -Config $cfg -Country $Country -Platform $Platform -Keywords $Keywords -TopK $TopK
      if ($null -ne $rows) {
        return [pscustomobject]@{ evidence = @($rows); provider = 'qianfan'; degraded = $false; degrade_reason = '' }
      }
      # 返回 null 表示端点通了但没结果 —— 这是合法结果，不回退
      return [pscustomobject]@{ evidence = @(); provider = 'qianfan'; degraded = $false; degrade_reason = '' }
    } catch {
      $why = '千帆知识库检索失败：' + $_.Exception.Message
      if (-not $cfg.fallback_local) {
        return [pscustomobject]@{ evidence = @(); provider = 'qianfan'; degraded = $true; degrade_reason = $why }
      }
      $local = @(Search-PolicyIndex -Country $Country -Platform $Platform -Keywords $Keywords -Top $TopK)
      return [pscustomobject]@{ evidence = $local; provider = 'local'; degraded = $true; degrade_reason = $why }
    }
  }

  $local2 = @(Search-PolicyIndex -Country $Country -Platform $Platform -Keywords $Keywords -Top $TopK)
  return [pscustomobject]@{ evidence = $local2; provider = 'local'; degraded = $false; degrade_reason = '' }
}

# ---------------------------------------------------------------------
# 千帆知识库检索
#
# ⚠️ 诚实说明：这条路径**尚未对接真实千帆接口**（我没有你的 AppBuilder/
#    MCP 凭据，无法验证）。这里定义的是**契约**：请求与响应的字段形状。
#    接的时候只要让 MCP Server / AppBuilder 适配这个契约，管线不用改。
#
#    请求（POST，JSON）：
#      { "query": "...", "top_k": 4, "country": "DE", "platform": "amazon",
#        "app_id": "...", "dataset": "..." }
#    期望响应（JSON）：
#      { "results": [ { "doc_id":"...", "title":"...", "snippet":"...",
#                       "score":0.87, "country":"DE", "platform":"SCOPE_GLOBAL",
#                       "effective_date":"2024-01-01" } ] }
#    字段名不同的话，改下面这段映射即可，不用动管线。
# ---------------------------------------------------------------------
function Search-KnowledgeQianfan {
  param($Config, [string]$Country, [string]$Platform, [string[]]$Keywords, [int]$TopK)

  $query = ($Keywords -join ' ')
  if ([string]::IsNullOrWhiteSpace($query)) { $query = '退货 消费者 救济' }

  $body = @{
    query    = $query
    top_k    = $TopK
    country  = $Country
    platform = $Platform
    app_id   = $Config.qianfan_app_id
    dataset  = $Config.qianfan_dataset
  } | ConvertTo-Json -Compress -Depth 4

  $headers = @{ 'Content-Type' = 'application/json' }
  if (-not [string]::IsNullOrWhiteSpace($Config.qianfan_token)) {
    $headers['Authorization'] = 'Bearer ' + $Config.qianfan_token
  }

  $json = Invoke-RestMethod -Uri $Config.qianfan_endpoint -Method POST -Body $body -Headers $headers `
            -ContentType 'application/json' -TimeoutSec ([math]::Max(3, [int]($Config.timeout_ms / 1000)))

  $items = @()
  if ($json -and ($json.PSObject.Properties.Name -contains 'results')) { $items = @($json.results) }
  elseif ($json -is [array]) { $items = @($json) }

  $out = @()
  foreach ($r in $items) {
    $out += [pscustomobject]@{
      doc_id         = [string]$r.doc_id
      title          = [string]$r.title
      snippet        = [string]$r.snippet
      score          = $(if ($null -ne $r.score) { [double]$r.score } else { 0.0 })
      country        = $(if ($r.country) { [string]$r.country } else { 'SCOPE_GLOBAL' })
      platform       = $(if ($r.platform) { [string]$r.platform } else { 'SCOPE_GLOBAL' })
      effective_date = [string]$r.effective_date
      source         = 'qianfan'
    }
  }
  return $out
}

# 连通性自检（界面上点"测试连接"用）
function Test-KnowledgeConnection {
  $cfg = Get-KnowledgeConfig
  if ([string]::IsNullOrWhiteSpace($cfg.qianfan_endpoint)) {
    return [pscustomobject]@{ ok = $false; reason = '未填写 qianfan_endpoint'; latency_ms = 0; sample = @() }
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $rows = @(Search-KnowledgeQianfan -Config $cfg -Country 'DE' -Platform 'amazon' -Keywords @('退货','消费者') -TopK 2)
    $sw.Stop()
    return [pscustomobject]@{ ok = $true; reason = ''; latency_ms = $sw.ElapsedMilliseconds; sample = @($rows) }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok = $false; reason = $_.Exception.Message; latency_ms = $sw.ElapsedMilliseconds; sample = @() }
  }
}
