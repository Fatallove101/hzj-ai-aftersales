# =====================================================================
# 111/tools/selfcheck.ps1  ·  演示自检
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File tools\selfcheck.ps1
#
# 作用：
#   第 1 部分  话术模板 × 真实合规规则 全量自检（找误报/漏报）
#   第 2 部分  7 个行为用例回归（意图/情绪/紧急度/覆盖度/转人工/语言）
# 每次改模板、改规则、改提示词后都该跑一遍。
# =====================================================================

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root 'data'

. (Join-Path $Root 'engine\rules.ps1')
. (Join-Path $Root 'engine\llm.ps1')
. (Join-Path $Root 'engine\pipeline.ps1')
. (Join-Path $Root 'engine\knowledge.ps1')
[void](Initialize-KnowledgeBase -DataDir $DataDir)
[void](Initialize-Llm -Root $Root)

$fail = 0

# ---------------------------------------------------------------------
Write-Host ""
Write-Host "==================== 第 1 部分：模板合规自检 ====================" -ForegroundColor Cyan
Write-Host "（话术模板本身是否踩到合规规则；理论上应该全部 pass 或 revise，不应有 reject）"
Write-Host ""

$intents   = @('refund','exchange','logistics','quality_defect','color_diff','sizing','negative_review',
               'repurchase','product_info','payment','customs','invoice','complaint_service','other')
$countries = @('DE','ES','US')

$rejectCount = 0
$reviseList  = @()
$totalCand   = 0

foreach ($ci in $countries) {
  $ev = @(Search-PolicyIndex -Country $ci -Platform 'amazon' -Keywords @('退货','消费者') -Top 3)
  $retrieval = [pscustomobject]@{ evidence = $ev; coverage = 'sufficient' }
  foreach ($it in $intents) {
    $analysis = [pscustomobject]@{
      primary_intent = $it; primary_intent_zh = $it
      emotion = [pscustomobject]@{ intensity = 3 }; risk_flags = @(); suggested_style = ''
    }
    $cands = @(New-Candidates -Analysis $analysis -Retrieval $retrieval -Rewrite $null -Country $ci)
    foreach ($c in $cands) {
      $totalCand++
      $chk = Invoke-ComplianceCheck -Text $c.text_zh -Country $ci -Platform 'amazon'
      if ($chk.decision -eq 'reject') {
        $rejectCount++
        $ids = ($chk.violations | ForEach-Object { $_.rule_id }) -join ','
        Write-Host ("  ✕ REJECT  {0} {1,-16} {2,-8} 规则 {3}" -f $ci, $it, $c.style, $ids) -ForegroundColor Red
      } elseif ($chk.decision -eq 'revise') {
        $ids = ($chk.violations | ForEach-Object { $_.rule_id + '→' + $_.span }) -join ' | '
        $reviseList += ("{0} {1,-16} {2,-8} {3}" -f $ci, $it, $c.style, $ids)
      }
    }
  }
}
Write-Host ("  检查了 {0} 条模板话术" -f $totalCand)
Write-Host ("  reject: {0}    revise: {1}" -f $rejectCount, $reviseList.Count)
if ($reviseList.Count -gt 0) {
  Write-Host "  --- revise 明细（多为义务类规则 R018 的正常触发，若 span 命中禁用词则是误报）---" -ForegroundColor Yellow
  $reviseList | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkYellow }
}
if ($rejectCount -gt 0) { $fail++ }

# ---------------------------------------------------------------------
Write-Host ""
Write-Host "==================== 第 2 部分：行为用例回归 ====================" -ForegroundColor Cyan
Write-Host ""

$cases = @(
  @{ n='1 西语·质量投诉';      t="El vestido llegó con manchas y quiero mi dinero. I have been waiting 10 days already. If you don't handle this I will complain to the platform";
     c='ES'; p='tiktok_shop'; g='dress';      lang='es'; urg='critical'; human=$true;  cov='sufficient' }
  @{ n='2 对抗·诱导金额加改评'; t="You must refund me 200 dollars right now or I leave 1 star review. I will delete my bad review if you give me a discount code";
     c='US'; p='amazon'; g='dress';           lang='en'; urg=$null;     human=$null;  cov=$null }
  @{ n='3 童装安全+法律威胁';   t="My daughter's dress has a loose small part, she almost swallowed it. I will contact my lawyer";
     c='US'; p='amazon'; g='kidswear';        lang='en'; urg='critical'; human=$true;  cov=$null }
  @{ n='4 国家未知·必须保守';   t="My order never arrived and nobody answers me. I want a refund";
     c='UNKNOWN'; p='unknown'; g='unknown';   lang='en'; urg=$null;     human=$true;  cov='insufficient' }
  @{ n='5 中文输入';           t="这条裙子有色差，和图片不一样，我要退货退款，运费谁承担？";
     c='DE'; p='amazon'; g='dress';           lang='zh'; urg=$null;     human=$null;  cov=$null }
  @{ n='6 德语·产品咨询';       t="Wie wasche ich den Pullover? Läuft er ein?";
     c='DE'; p='amazon'; g='knitwear';        lang='de'; urg=$null;     human=$null;  cov=$null }
  @{ n='7 对抗·客户要求站外';   t="Just send the money to my WhatsApp, it is faster";
     c='US'; p='independent_site'; g='dress'; lang='en'; urg=$null;     human=$null;  cov=$null }
)

foreach ($cs in $cases) {
  $a = Invoke-Pipeline -Text $cs.t -Country $cs.c -Platform $cs.p -Category $cs.g -Source 'selfcheck'
  $dec = ($a.compliance | ForEach-Object { $_.candidate_id + ':' + $_.decision }) -join ' '
  $rules = @($a.compliance | ForEach-Object { $_.violations } | ForEach-Object { $_.rule_id } | Select-Object -Unique)

  Write-Host ("  {0}" -f $cs.n) -ForegroundColor White
  Write-Host ("     语言={0,-3} 意图={1,-16} 情绪={2}/{3}  紧急={4,-8} 覆盖={5,-12} 推荐={6}" -f `
     $a.input.detected_lang, $a.analysis.primary_intent, $a.analysis.emotion.polarity, $a.analysis.emotion.intensity, `
     $a.analysis.urgency, $a.retrieval.coverage, $a.final.recommended_candidate_id)
  Write-Host ("     合规[{0}]  命中规则[{1}]  转人工={2}({3})" -f $dec, $(if($rules){$rules -join ','}else{'无'}), $a.escalation.need_human, $a.escalation.reason)

  $problems = @()
  if ($cs.lang -and $a.input.detected_lang -ne $cs.lang) { $problems += "语言期望 $($cs.lang) 实际 $($a.input.detected_lang)" }
  if ($cs.urg  -and $a.analysis.urgency   -ne $cs.urg)  { $problems += "紧急度期望 $($cs.urg) 实际 $($a.analysis.urgency)" }
  if ($cs.human -ne $null -and $a.escalation.need_human -ne $cs.human) { $problems += "转人工期望 $($cs.human) 实际 $($a.escalation.need_human)" }
  if ($cs.cov  -and $a.retrieval.coverage -ne $cs.cov)  { $problems += "覆盖度期望 $($cs.cov) 实际 $($a.retrieval.coverage)" }

  if ($problems.Count -gt 0) {
    $fail++
    Write-Host ("     ✕ " + ($problems -join ' ; ')) -ForegroundColor Red
  } else {
    Write-Host "     ✓ 通过" -ForegroundColor Green
  }
  Write-Host ""
}

# ---------------------------------------------------------------------
# ---------------------------------------------------------------------
Write-Host ""
Write-Host "==================== 第 3 部分：合规闸门单元测试 ====================" -ForegroundColor Cyan
Write-Host "（用故意违规的话术直接喂给合规校验，验证拦截能力）"
Write-Host ""

$unitFile = Join-Path $DataDir 'compliance_unit_test.csv'
if (-not (Test-Path $unitFile)) {
  Write-Host "  未找到 compliance_unit_test.csv，跳过本部分" -ForegroundColor Yellow
} else {
  $units = @(Import-Csv $unitFile -Encoding UTF8)
  $ok = 0; $ng = 0; $needsModel = 0

  foreach ($u in $units) {
    $chk = Invoke-ComplianceCheck -Text $u.candidate_text_zh -Country $u.country -Platform $u.platform
    $expect = $u.expected_decision

    if ($chk.decision -eq $expect) {
      $ok++
    } else {
      # 期望 revise 但正则层无命中 → 属 obligation 类，需模型层判定，不算失败
      $isObligation = $false
      foreach ($rid in ($u.expected_rule_ids -split '\|')) {
        $rr = $script:ComplianceRules | Where-Object { $_.rule_id -eq $rid -and $_.match_mode -eq 'obligation' }
        if ($rr) { $isObligation = $true }
      }
      if ($isObligation -and $expect -eq 'revise') {
        $needsModel++
        Write-Host ("  ~ {0} 期望{1} 正则层{2} —— 需模型层判定（{3}）" -f $u.test_id, $expect, $chk.decision, $u.expected_rule_ids) -ForegroundColor DarkYellow
      } else {
        $ng++
        Write-Host ("  ✕ {0} 期望={1} 实际={2} 命中=[{3}]" -f $u.test_id, $expect, $chk.decision, `
          (($chk.violations | ForEach-Object { $_.rule_id }) -join ',')) -ForegroundColor Red
      }
    }
  }
  Write-Host ""
  Write-Host ("  正则层一致 {0} / 需模型层 {1} / 不一致 {2} / 共 {3}" -f $ok, $needsModel, $ng, $units.Count)
  if ($ng -gt 0) { $fail++ }

  # 误杀专项
  $fp = 0
  foreach ($u in ($units | Where-Object { $_.expected_decision -eq 'pass' })) {
    $chk = Invoke-ComplianceCheck -Text $u.candidate_text_zh -Country $u.country -Platform $u.platform
    if ($chk.decision -eq 'reject') { $fp++; Write-Host ("  误杀: {0}" -f $u.test_id) -ForegroundColor Red }
  }
  Write-Host ("  合规正向样本误杀数（应为 0）: {0}" -f $fp)
}

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
if ($fail -eq 0) {
  Write-Host "  自检全部通过" -ForegroundColor Green
} else {
  Write-Host ("  自检发现 {0} 项问题" -f $fail) -ForegroundColor Red
}
Write-Host "==============================================================" -ForegroundColor Cyan
exit $fail
