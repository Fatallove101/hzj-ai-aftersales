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
  return [pscustomobject]@{
    compliance_rules = $script:ComplianceRules.Count
    glossary         = $script:Glossary.Count
    policy_index     = $script:PolicyIndex.Count
    intent_taxonomy  = $script:IntentTaxonomy.Count
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
