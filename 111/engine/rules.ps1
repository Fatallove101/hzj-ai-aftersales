# =====================================================================
# 111/engine/rules.ps1
# 知识层：加载种子数据 + 真实正则合规校验
# 说明：本文件是真实实现，不是 mock。
#       compliance_rules.csv 的 pattern 会被真实执行，
#       glossary / policy_index / intent_taxonomy 都是真实数据。
# =====================================================================

# 注意：变量名不要用 $DataDir —— server.ps1 dot-source 本文件时会同名覆盖
$script:KnowledgeDataDir = $null
$script:ComplianceRules = @()
$script:Glossary        = @()
$script:PolicyIndex     = @()
$script:IntentTaxonomy  = @()

# 商户自定义的禁用表述：存 data/custom_rules.json，启动时并进合规规则表。
# 与 CSV 里的种子规则走**完全相同**的检测逻辑（match_mode = violation）。
$script:CustomRulesPath = $null
$script:CustomRules     = @()

# 欧盟成员国（用于把 EU 级规则匹配到具体国家）
$script:EuCountries = @('DE','FR','ES','IT','NL','BE','PL','AT','PT','IE','SE','DK','FI','GR','CZ','RO','HU','LU','SK','SI','HR','EE','LV','LT','MT','CY','BG')

$script:CountryZh = @{
  'DE'='德国'; 'ES'='西班牙'; 'FR'='法国'; 'US'='美国'; 'GB'='英国'; 'IT'='意大利'
  'NL'='荷兰'; 'EU'='欧盟'; 'CN'='中国'; 'ALL'='通用'; 'UNKNOWN'='未知'
}

function Initialize-KnowledgeBase {
  param([Parameter(Mandatory)][string]$DataDir)
  $script:KnowledgeDataDir = $DataDir
  $script:ComplianceRules = @(Import-Csv -Path (Join-Path $DataDir 'compliance_rules.csv')        -Encoding UTF8)
  $script:Glossary        = @(Import-Csv -Path (Join-Path $DataDir 'glossary_zh_en_es_de_fr.csv') -Encoding UTF8)
  $script:PolicyIndex     = @(Import-Csv -Path (Join-Path $DataDir 'policy_index.csv')            -Encoding UTF8)
  $script:IntentTaxonomy  = @(Import-Csv -Path (Join-Path $DataDir 'intent_taxonomy.csv')         -Encoding UTF8)

  # 商户自定义禁用表述：并进规则表，走同一套检测逻辑
  $script:CustomRulesPath = Join-Path $DataDir 'custom_rules.jsonl'
  $script:CustomRules = @(Read-CustomRules)
  foreach ($cr in $script:CustomRules) { $script:ComplianceRules += $cr }

  return [pscustomobject]@{
    compliance_rules = $script:ComplianceRules.Count
    custom_rules     = $script:CustomRules.Count
    glossary         = $script:Glossary.Count
    policy_index     = $script:PolicyIndex.Count
    intent_taxonomy  = $script:IntentTaxonomy.Count
  }
}

# ---------------------------------------------------------------------
# 自定义禁用表述
# ---------------------------------------------------------------------
function Read-CustomRules {
  if ([string]::IsNullOrWhiteSpace($script:CustomRulesPath)) { return @() }
  if (-not (Test-Path $script:CustomRulesPath)) { return @() }
  try {
    $raw = Get-Content $script:CustomRulesPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $arr = @(Read-CustomRulesRaw)
  } catch {
    Write-Warning ('自定义规则文件解析失败，已忽略：' + $_.Exception.Message)
    return @()
  }
  $out = @()
  foreach ($r in $arr) {
    if ([string]::IsNullOrWhiteSpace($r.pattern)) { continue }
    # 正则合法性在这里就验证 —— 坏正则会让整个合规层静默失效
    try { [void][regex]::Match('', $r.pattern) } catch {
      Write-Warning ('自定义规则 ' + $r.id + ' 的正则非法，已跳过：' + $r.pattern)
      continue
    }
    $out += [pscustomobject]@{
      rule_id      = [string]$r.id
      category     = 'custom'
      severity     = $(if ($r.severity) { [string]$r.severity } else { 'warn' })
      title        = $(if ($r.title) { [string]$r.title } else { '自定义禁用表述' })
      pattern      = [string]$r.pattern
      match_mode   = 'violation'
      description  = $(if ($r.reason) { [string]$r.reason } else { '命中商户自定义禁用表述' })
      applies_country  = 'SCOPE_GLOBAL'
      applies_platform = 'SCOPE_GLOBAL'
      revise_hint  = $(if ($r.suggestion) { [string]$r.suggestion } else { '请改写措辞，避开该表述' })
      effective_date = $(if ($r.created_at) { ([string]$r.created_at).Substring(0, [math]::Min(10, ([string]$r.created_at).Length)) } else { '' })
      verified_by  = '商户自定义'
      verified_date = ''
      status       = 'custom'
    }
  }
  return $out
}

function Save-CustomRules {
  param([array]$Rules)
  if ([string]::IsNullOrWhiteSpace($script:CustomRulesPath)) { throw '自定义规则路径未初始化' }
  # JSONL：一行一条，逐条独立序列化。见 Read-CustomRulesRaw 的说明。
  $lines = New-Object System.Collections.ArrayList
  foreach ($r in @($Rules)) {
    if ($null -eq $r) { continue }
    $o = [pscustomobject]@{
      id         = [string]$r.id
      title      = [string]$r.title
      pattern    = [string]$r.pattern
      severity   = [string]$r.severity
      reason     = [string]$r.reason
      suggestion = [string]$r.suggestion
      created_at = [string]$r.created_at
    }
    [void]$lines.Add(($o | ConvertTo-Json -Compress -Depth 3))
  }
  $text = if ($lines.Count -eq 0) { '' } else { ($lines.ToArray() -join "`n") + "`n" }
  [System.IO.File]::WriteAllText($script:CustomRulesPath, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-CustomRule {
  param(
    [Parameter(Mandatory)][string]$Pattern,
    [string]$Title = '自定义禁用表述',
    [string]$Severity = 'warn',
    [string]$Reason = '',
    [string]$Suggestion = ''
  )
  if ([string]::IsNullOrWhiteSpace($Pattern)) { throw '禁用表述不能为空' }
  # 先验证正则：宁可当场报错，也不要让坏正则悄悄毁掉整个合规层
  try { [void][regex]::Match('测试文本', $Pattern) }
  catch { throw ('正则表达式不合法：' + $_.Exception.Message) }
  if (@('warn','block') -notcontains $Severity) { $Severity = 'warn' }

  $list = @(Read-CustomRulesRaw)
  # 生成不冲突的 id
  $n = 1
  $existing = @($list | ForEach-Object { $_.id })
  while ($existing -contains ('C{0:d3}' -f $n)) { $n++ }
  $item = [ordered]@{
    id         = 'C{0:d3}' -f $n
    title      = $Title
    pattern    = $Pattern
    severity   = $Severity
    reason     = $Reason
    suggestion = $Suggestion
    created_at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
  $list += [pscustomobject]$item
  Save-CustomRules -Rules $list
  return $item
}

function Remove-CustomRule {
  param([Parameter(Mandatory)][string]$Id)
  $list = @(Read-CustomRulesRaw)
  $keep = @($list | Where-Object { $_.id -ne $Id })
  if ($keep.Count -eq $list.Count) { return $false }
  Save-CustomRules -Rules $keep
  return $true
}

# 读原始记录。
#
# ⚠️ 存储格式是 **JSONL**（一行一条），不是 JSON 数组。
#    原因：PowerShell 5.1 的 ConvertTo-Json 处理数组有两个坑 ——
#      ① -InputObject <数组> 会把它包成 { "value": [...], "Count": n }
#      ② 管道输出多个对象时行为又不一样
#    结果就是读回来属性变成 System.Object[]、多条规则被并成一个对象，
#    症状是"规则计入总数却永远不生效"，极难排查。
#    JSONL 每行独立序列化/反序列化，彻底绕开这些问题
#    （本项目 logs/qa_logs.jsonl 用的也是同一思路）。
function Read-CustomRulesRaw {
  if ([string]::IsNullOrWhiteSpace($script:CustomRulesPath)) { return @() }
  if (-not (Test-Path $script:CustomRulesPath)) { return @() }
  $out = @()
  try {
    foreach ($line in @(Get-Content $script:CustomRulesPath -Encoding UTF8)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if ($null -ne $o) { $out += $o }
    }
  } catch { return @() }
  return $out
}

# 供界面显示（合并"存储字段 + 当前是否生效"）
function Get-CustomRulesForUi {
  $raw = @(Read-CustomRulesRaw)
  $out = @()
  foreach ($r in $raw) {
    $valid = $true
    try { [void][regex]::Match('', [string]$r.pattern) } catch { $valid = $false }
    $out += [pscustomobject]@{
      id = $r.id; title = $r.title; pattern = $r.pattern
      severity = $r.severity; reason = $r.reason; suggestion = $r.suggestion
      created_at = $r.created_at; valid = $valid
    }
  }
  return $out
}

# 改完自定义规则后热重载（不必重启服务）
function Reload-ComplianceRules {
  if ([string]::IsNullOrWhiteSpace($script:KnowledgeDataDir)) { return 0 }
  $base = @(Import-Csv -Path (Join-Path $script:KnowledgeDataDir 'compliance_rules.csv') -Encoding UTF8)
  $script:CustomRules = @(Read-CustomRules)
  foreach ($cr in $script:CustomRules) { $base += $cr }
  $script:ComplianceRules = $base
  return $script:CustomRules.Count
}

# ---------------------------------------------------------------------
# 新规则的"误杀"自检
#
# 用户加自定义禁用表述时最常见的错误是正则写得太宽（例如写"由我们承担"，
# 而合法话术里本来就有"运费由我们承担"）。加规则时立刻拿合规正向样本
# 试一遍，命中就当场警告 —— 否则用户会看到好好的话术突然全被拦掉。
# ---------------------------------------------------------------------
function Test-CustomRuleFalsePositive {
  param([Parameter(Mandatory)][string]$Pattern)
  if ([string]::IsNullOrWhiteSpace($script:KnowledgeDataDir)) { return @() }
  $csv = Join-Path $script:KnowledgeDataDir 'compliance_unit_test.csv'
  if (-not (Test-Path $csv)) { return @() }
  $rows = @()
  try { $rows = @(Import-Csv -Path $csv -Encoding UTF8) } catch { return @() }
  $hits = @()
  foreach ($r in $rows) {
    if ([string]$r.expected_decision -ne 'pass') { continue }
    $text = [string]$r.candidate_text_zh
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    try {
      if ([regex]::IsMatch($text, $Pattern)) {
        $hits += [pscustomobject]@{ test_id = $r.test_id; text = $text }
      }
    } catch { }
  }
  return $hits
}

# 实时统计。
# ⚠️ 不要在 /api/health 里直接返回启动时算好的快照 ——
#    界面加了自定义规则之后那个数字就不准了（踩过：明明加成功却显示 0）。
function Get-KbCounts {
  return [pscustomobject]@{
    compliance_rules = @($script:ComplianceRules).Count
    custom_rules     = @($script:CustomRules).Count
    glossary         = @($script:Glossary).Count
    policy_index     = @($script:PolicyIndex).Count
    intent_taxonomy  = @($script:IntentTaxonomy).Count
  }
}

function Get-CountryZh {
  param([string]$Code)
  if ($script:CountryZh.ContainsKey($Code)) { return $script:CountryZh[$Code] }
  return $Code
}

function Test-RuleCountry {
  param([string]$Scope, [string]$Country)
  if ([string]::IsNullOrWhiteSpace($Scope)) { return $false }
  if ($Scope -eq 'SCOPE_GLOBAL') { return $true }
  $list = $Scope -split '\|'
  if ($list -contains $Country) { return $true }
  if ($Country -eq 'EU' -and $list -contains 'EU') { return $true }
  return $false
}

function Get-ApplicableRules {
  param([string]$Country)
  return @($script:ComplianceRules | Where-Object { Test-RuleCountry -Scope $_.applies_country -Country $Country })
}

# ---------------------------------------------------------------------
# 合规校验：真实执行 compliance_rules.csv 的正则
#   match_mode = violation  → 正则命中即违规
#   match_mode = obligation → 正则只判"是否适用"，是否履行交给模型层
#                             （演示版用关键词判断"该说的说了没有"）
# ---------------------------------------------------------------------
function Invoke-ComplianceCheck {
  param(
    [Parameter(Mandatory)][string]$Text,
    [string]$Country = 'UNKNOWN',
    [string]$Platform = 'unknown'
  )
  $violations = @()

  foreach ($r in Get-ApplicableRules -Country $Country) {

    if ($r.match_mode -eq 'violation') {
      $m = $null
      try { $m = [regex]::Match($Text, $r.pattern) } catch { continue }
      if ($m.Success) {
        $violations += [pscustomobject]@{
          rule_id    = $r.rule_id
          category   = $r.category
          severity   = $r.severity
          title      = $r.title
          span       = $m.Value
          reason     = $r.description
          suggestion = $r.revise_hint
        }
      }
      continue
    }

    if ($r.match_mode -eq 'obligation') {
      $applies = $false
      try { $applies = [regex]::IsMatch($Text, $r.pattern) } catch { $applies = $false }
      if (-not $applies) { continue }

      $fulfilled = $false
      switch ($r.rule_id) {
        'R018' { $fulfilled = ($Text -match '(14\s*(天|日)|14\s*(days|días|Tage|jours|tage))') }
        'R019' { $fulfilled = ($Text -match '(Widerrufsrecht|撤回权|撤回權)') }
        default { $fulfilled = $true }
      }
      if (-not $fulfilled) {
        $violations += [pscustomobject]@{
          rule_id    = $r.rule_id
          category   = $r.category
          severity   = $r.severity
          title      = $r.title
          span       = '（缺少法定应告知内容）'
          reason     = $r.description
          suggestion = $r.revise_hint
        }
      }
    }
  }

  $block  = @($violations | Where-Object { $_.severity -eq 'block' })
  $revise = @($violations | Where-Object { $_.severity -eq 'revise' })
  $decision = 'pass'
  if ($block.Count -gt 0)       { $decision = 'reject' }
  elseif ($revise.Count -gt 0)  { $decision = 'revise' }

  return [pscustomobject]@{
    decision   = $decision
    violations = $violations
  }
}

# ---------------------------------------------------------------------
# 术语库匹配（真实数据）
# ---------------------------------------------------------------------
function Get-GlossaryHits {
  param([Parameter(Mandatory)][string]$Text)
  $hits = @()
  foreach ($g in $script:Glossary) {
    if ([string]::IsNullOrWhiteSpace($g.term_zh)) { continue }
    if ($Text -like "*$($g.term_zh)*") {
      $hits += [pscustomobject]@{ source_term = $g.term_zh; target_term = $g.term_en; term_id = $g.term_id; category = $g.category }
    }
  }
  return $hits
}

# 从外文文本里反查命中术语（OCR 出来的外文 → 对应中文）
function Get-GlossaryHitsByForeign {
  param([Parameter(Mandatory)][string]$Text)
  $hits = @()
  $lower = $Text.ToLower()
  foreach ($g in $script:Glossary) {
    foreach ($lang in @('term_en','term_es','term_de','term_fr')) {
      $v = $g.$lang
      if ([string]::IsNullOrWhiteSpace($v)) { continue }
      foreach ($piece in ($v -split '/')) {
        $p = $piece.Trim().ToLower()
        if ($p.Length -lt 4) { continue }
        if ($lower -like "*$p*") {
          $hits += [pscustomobject]@{ foreign = $piece.Trim(); term_zh = $g.term_zh; lang = $lang; term_id = $g.term_id }
          break
        }
      }
    }
  }
  return $hits
}

# ---------------------------------------------------------------------
# 政策检索（真实数据 + 关键词语义近似打分）
# ---------------------------------------------------------------------
function Search-PolicyIndex {
  param(
    [Parameter(Mandatory)][string]$Country,
    [string]$Platform = 'unknown',
    [string[]]$Keywords = @(),
    [int]$Top = 4
  )
  $scored = @()
  foreach ($p in $script:PolicyIndex) {
    $cMatch = $false
    if ($p.country -eq $Country)                    { $cMatch = $true }
    elseif ($p.country -eq 'ALL')                   { $cMatch = $true }
    elseif ($p.country -eq 'EU' -and ($script:EuCountries -contains $Country)) { $cMatch = $true }
    if (-not $cMatch) { continue }

    if ($p.applies_platform -ne 'ALL' -and $Platform -ne 'unknown') {
      if ($p.applies_platform -notlike "*$Platform*") { continue }
    }

    $score = 0.30
    if ($p.country -eq $Country) { $score += 0.25 }
    elseif ($p.country -eq 'EU') { $score += 0.15 }
    else                         { $score += 0.05 }

    if ($p.applies_platform -ne 'ALL' -and $p.applies_platform -like "*$Platform*") { $score += 0.10 }

    $text = "$($p.policy_name) $($p.policy_name_local) $($p.key_rule)"
    foreach ($k in $Keywords) {
      if ([string]::IsNullOrWhiteSpace($k)) { continue }
      if ($text -like "*$k*") { $score += 0.08 }
    }
    if ($score -gt 0.95) { $score = 0.95 }

    $scored += [pscustomobject]@{
      doc_id         = $p.doc_id
      country        = $p.country
      region         = $p.region
      title          = $p.policy_name
      snippet        = $p.key_rule
      return_days    = $p.return_window_days
      shipping_payer = $p.return_shipping_payer
      effective_date = $p.effective_date
      source_url     = $p.source_url
      status         = $p.status
      score          = [math]::Round($score, 2)
    }
  }
  $sorted = @($scored | Sort-Object -Property score -Descending)
  if ($sorted.Count -gt $Top) { $sorted = $sorted[0..($Top-1)] }
  return $sorted
}
