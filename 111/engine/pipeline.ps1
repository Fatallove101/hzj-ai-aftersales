# =====================================================================
# 111/engine/pipeline.ps1
# 7-Agent 处理管线（本地规则版）
#
# 真实执行的部分：意图识别（读 intent_taxonomy）、合规校验（读 compliance_rules 正则）、
#                 术语命中（读 glossary）、政策检索（读 policy_index）、主控汇总与转人工判定
# 规则近似的部分：翻译（本地词表）、话术生成（模板）
#   → 接入千帆后，这两步换成翻译 Agent / 话术生成 Agent 的真实模型调用即可，
#     其余部分与线上设计完全一致。
# =====================================================================

# ---------------------------------------------------------------------
# A1 语言识别
# ---------------------------------------------------------------------
function Get-LanguageGuess {
  param([Parameter(Mandatory)][string]$Text)
  if ($Text -match '[\u4e00-\u9fa5]') { return 'zh' }

  $lower = $Text.ToLower()
  $markers = @{
    es = @('que','quiero','vestido','llegó','llego','con','para','está','esta','muy','gracias','dinero','devolución','pero','tengo','pedido','paquete','talla','reembolso','manchas','días')
    de = @('ich','nicht','das','ist','und','sie','möchte','habe','kleid','rückerstattung','bitte','bestellung','paket','größe','fleck','kaputt','widerruf','tage')
    fr = @('je','pas','le','la','vous','pour','colis','remboursement','bonjour','merci','commande','taille','tache','jours','défaut')
    en = @('the','and','want','my','is','you','please','refund','order','package','dress','size','damaged','stain','days','money','back','review')
  }
  $best = 'en'; $bestScore = 0
  foreach ($lang in @('es','de','fr','en')) {
    $score = 0
    foreach ($w in $markers[$lang]) {
      if ($lower -match "(^|[^a-zà-ÿ])$([regex]::Escape($w))([^a-zà-ÿ]|$)") { $score++ }
    }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $lang }
  }
  return $best
}

# ---------------------------------------------------------------------
# A2 意图情绪（读取 intent_taxonomy.csv 的真实关键词）
# ---------------------------------------------------------------------
function Get-IntentAnalysis {
  param(
    [Parameter(Mandatory)][string]$Text,
    [string]$Country = 'UNKNOWN'
  )
  $lower = $Text.ToLower()
  $scored = @()

  foreach ($row in $script:IntentTaxonomy) {
    if ($row.label -eq 'other') { continue }
    $hits = 0
    $matched = @()

    foreach ($kw in ($row.signal_keywords_zh -split '\|')) {
      $k = $kw.Trim()
      if ($k.Length -ge 2 -and $Text -like "*$k*") { $hits++; $matched += $k }
    }
    foreach ($field in @('signal_keywords_en','signal_keywords_es','signal_keywords_de','signal_keywords_fr')) {
      foreach ($kw in ($row.$field -split '/')) {
        $k = $kw.Trim().ToLower()
        if ($k.Length -lt 3) { continue }
        if ($lower -like "*$k*") { $hits++; $matched += $k }
      }
    }
    if ($hits -gt 0) {
      $conf = [math]::Min(0.96, 0.55 + 0.13 * $hits)
      $scored += [pscustomobject]@{
        label = $row.label; label_zh = $row.label_zh; confidence = [math]::Round($conf,2)
        hits = $hits; matched = @($matched | Select-Object -Unique)
        default_style = $row.default_style; priority = [int]$row.priority
      }
    }
  }

  $scored = @($scored | Sort-Object -Property @{Expression='hits';Descending=$true}, @{Expression='priority';Descending=$false})
  if ($scored.Count -eq 0) {
    $otherRow = $script:IntentTaxonomy | Where-Object { $_.label -eq 'other' } | Select-Object -First 1
    $scored = @([pscustomobject]@{
      label='other'; label_zh='其他'; confidence=0.40; hits=0; matched=@()
      default_style='安抚致歉'; priority=4
    })
  }
  $top = @($scored | Select-Object -First 3)

  # 情绪
  $negStrong = @('estafa','scam','fraud','betrug','arnaqu','骗子','诈骗','垃圾','太过分','不可接受','unacceptable','inakzeptabel','律师','起诉','报警','曝光','投诉到平台','abogado','anwalt','avocat','lawyer','sue','denunciar')
  $negMild   = @('manchas','roto','defectuoso','kaputt','fleck','tache','cassé','broken','damaged','stain','disappointed','mal','bad','太差','失望','不满意','no reply','没人回复','等了','waited','gewartet')
  $posWords  = @('gracias','thank','danke','merci','谢谢','满意','perfect','great','excelente')

  $intensity = 2
  $signals = @()
  foreach ($w in $negStrong) { if ($lower -like "*$w*") { $intensity = 5; $signals += $w } }
  if ($intensity -lt 4) { foreach ($w in $negMild) { if ($lower -like "*$w*") { if ($intensity -lt 3) { $intensity = 3 }; $signals += $w } } }
  foreach ($w in $posWords) { if ($lower -like "*$w*") { $signals += $w } }

  $polarity = 'neutral'
  if ($intensity -ge 3) { $polarity = 'negative' }
  elseif (@($signals | Where-Object { $posWords -contains $_ }).Count -gt 0) { $polarity = 'positive'; $intensity = 1 }
  if ($signals.Count -eq 0) { $intensity = 1 }

  # 紧急度
  $urgency = 'medium'
  $criticalMarkers = @('abogado','anwalt','avocat','lawyer','denunciar','sue','起诉','律师','报警','chargeback','拒付','contracargo','A-to-z','claim','reclamación','投诉到平台','找平台','disputa','曝光','posting this','社交媒体','绳带','窒息','swallow','child','kid','女儿','儿子','孩子','儿童','阻燃','过敏','allergy')
  $highMarkers = @('refund','退款','退货','complain','投诉','waiting','等了','gewartet','no reply','没人回复','stain','污渍','broken','破损','差评','bad review','1 star','一星')

  foreach ($m in $criticalMarkers) { if ($lower -like "*$m*") { $urgency = 'critical'; break } }
  if ($urgency -ne 'critical') {
    foreach ($m in $highMarkers) { if ($lower -like "*$m*") { $urgency = 'high'; break } }
  }
  if ($urgency -eq 'medium' -and $top[0].label -in @('product_info','invoice','repurchase')) { $urgency = 'low' }

  # 风险标记
  $risk = @()
  if ($lower -match '(chargeback|拒付|contracargo|A-to-z|claim|reclamación|disputa)') { $risk += 'chargeback_risk' }
  if ($lower -match '(投诉到平台|找平台|complain to the platform|intervención|platform|仲裁|开case|opened a case)') { $risk += 'platform_intervention_risk' }
  if ($lower -match '(abogado|anwalt|avocat|lawyer|sue|起诉|denunciar|律师|报警|过敏|allergy|窒息|swallow|绳带|阻燃)') { $risk += 'legal_risk' }
  if ($lower -match '(曝光|posting this|社交媒体|social media|发到网上|直播揭发)') { $risk += 'public_opinion_risk' }
  if ($lower -match '(child|kid|女儿|儿子|孩子|儿童|baby|infant)') { $risk += 'minor_involved' }

  # 命中高风险标记时紧急度一律提升为 critical（与设计文档第 8 节一致：
  # 平台介入 / 拒付 / 法律风险 任一命中即为最高优先级，漏判代价远高于误判）
  if (@($risk | Where-Object { $_ -in @('legal_risk','platform_intervention_risk','chargeback_risk') }).Count -gt 0) {
    $urgency = 'critical'
  }

  $primaryStyle = $top[0].default_style
  if ($urgency -eq 'critical' -and $primaryStyle -eq '安抚致歉') { $primaryStyle = '纠纷调解' }

  $needHumanHint = $false
  if ($urgency -eq 'critical') { $needHumanHint = $true }
  if ($polarity -eq 'negative' -and $intensity -ge 4) { $needHumanHint = $true }
  if (@($risk | Where-Object { $_ -in @('legal_risk','platform_intervention_risk','chargeback_risk') }).Count -gt 0) { $needHumanHint = $true }

  return [pscustomobject]@{
    intents         = $top
    primary_intent  = $top[0].label
    primary_intent_zh = $top[0].label_zh
    emotion         = [pscustomobject]@{ polarity=$polarity; intensity=$intensity; signals=@($signals | Select-Object -Unique -First 5) }
    urgency         = $urgency
    risk_flags      = @($risk | Select-Object -Unique)
    need_human_hint = $needHumanHint
    suggested_style = $primaryStyle
  }
}

# ---------------------------------------------------------------------
# A3 查询改写
# ---------------------------------------------------------------------
function Get-QueryRewrite {
  param($Analysis, [string]$Country='UNKNOWN', [string]$Platform='unknown', [string]$Category='unknown')
  $q = @()
  $zh = $Analysis.primary_intent_zh
  $cZh = Get-CountryZh -Code $Country
  $q += "$cZh 服装 $zh 处理规则 政策"
  $q += "$Platform $cZh 站点 售后 规则 争议处理"

  $kb = @('policy_kb','platform_rule_kb')
  switch ($Analysis.primary_intent) {
    'quality_defect' { $q += '服装 质量问题 瑕疵 退换货 责任 运费承担'; $kb += 'product_kb'; $kb += 'case_kb' }
    'color_diff'     { $q += '服装 色差 判定标准 退换货'; $kb += 'product_kb'; $kb += 'case_kb' }
    'sizing'         { $q += '服装 尺码表 尺码偏差 换货'; $kb += 'product_kb' }
    'logistics'      { $q += '跨境 物流 延误 丢件 处理流程'; $kb += 'case_kb' }
    'product_info'   { $q += '服装 面料 成分 洗涤 保养 标准'; $kb = @('product_kb','case_kb') }
    'customs'        { $q += '跨境 关税 清关 责任 告知'; }
    'repurchase'     { $q += '服装 复购 推荐 搭配'; $kb = @('product_kb','case_kb') }
    'negative_review'{ $q += '差评 平台介入 争议 处理 案例'; $kb += 'case_kb' }
    default          { $kb += 'case_kb' }
  }

  $region = ''
  if ($script:EuCountries -contains $Country) { $region = 'EU' }

  return [pscustomobject]@{
    queries = @($q | Select-Object -Unique)
    filters = [pscustomobject]@{
      country = $Country; region = $region; platform = $Platform
      category = $Category; lang = ''; policy_version = 'latest'; effective_before = 'today'
    }
    kb_route = @($kb | Select-Object -Unique)
  }
}

# ---------------------------------------------------------------------
# 检索 + 覆盖度判定
# ---------------------------------------------------------------------
function Invoke-Retrieval {
  param($Rewrite, $Analysis, [string]$Country='UNKNOWN', [string]$Platform='unknown')
  $kw = @()
  switch ($Analysis.primary_intent) {
    'refund'          { $kw = @('退款','撤回','退货','消费者') }
    'quality_defect'  { $kw = @('瑕疵','不符合','救济','退货','消费者') }
    'color_diff'      { $kw = @('瑕疵','不符合','退货','消费者') }
    'sizing'          { $kw = @('不符合','退货','尺寸'); }
    'logistics'       { $kw = @('发货','邮购','退货') }
    'customs'         { $kw = @('关税','清关','退货') }
    'negative_review' { $kw = @('退货','消费者','救济') }
    'product_info'    { $kw = @('安全','标准','绳带','阻燃') }
    'invoice'         { $kw = @('退货','消费者') }
    default           { $kw = @('退货','消费者') }
  }
  $evidence = @(Search-PolicyIndex -Country $Country -Platform $Platform -Keywords $kw -Top 4)

  $hasPolicy = @($evidence | Where-Object { $_.doc_id -like 'EU-*' -or $_.doc_id -like 'DE-*' -or $_.doc_id -like 'FR-*' -or $_.doc_id -like 'ES-*' -or $_.doc_id -like 'GB-*' -or $_.doc_id -like 'US-*' -or $_.doc_id -like 'IT-*' -or $_.doc_id -like 'KID-*' }).Count -gt 0
  $coverage = 'insufficient'
  if ($Country -eq 'UNKNOWN') { $coverage = 'insufficient' }
  elseif ($hasPolicy)         { $coverage = 'sufficient' }
  elseif ($evidence.Count -gt 0) { $coverage = 'partial' }

  return [pscustomobject]@{ evidence = $evidence; coverage = $coverage }
}

# ---------------------------------------------------------------------
# A4 话术生成（模板版）
# ---------------------------------------------------------------------
function Get-CandidateTemplates {
  param([string]$Intent, [string]$CountryZh, [string]$Days, [string]$Payer)
  $d = $Days; if ([string]::IsNullOrWhiteSpace($d) -or $d -eq 'NA') { $d = '按平台规则' }
  $p = $Payer; if ([string]::IsNullOrWhiteSpace($p) -or $p -eq 'NA') { $p = '按责任认定' }

  $all = @{
    'refund' = @(
      @{ style='安抚致歉'; zh="非常抱歉给您带来不好的体验，$CountryZh 订单遇到这样的问题我们很重视。您可以选择退款或换货，我们会全程配合您处理，退回运费不需要您承担。方便的话请提供一张实物照片，我们立刻为您安排。";
         en="We are very sorry about your experience with this $CountryZh order. You may choose a refund or an exchange, and we will support you through the whole process. Return shipping is on us. If you can send a photo of the item, we will arrange it right away.";
         es="Lamentamos mucho su experiencia con este pedido. Puede elegir el reembolso o el cambio, y le acompañaremos en todo el proceso. Los gastos de devolución corren por nuestra cuenta. Si puede enviarnos una foto, lo gestionaremos de inmediato.";
         next='请客户提供实物照片' }
      @{ style='纠纷调解'; zh="我们已经核对了您的订单，正在按 $CountryZh 的消费者保护规定处理。按照当地规定，商品存在瑕疵时您有权选择退款或换货，$d。我们会在核实后第一时间告知您方案。";
         en="We have reviewed your order and are handling it in line with $CountryZh consumer protection rules. Under local rules, when an item is defective you may choose a refund or an exchange, $d. We will update you with a solution as soon as verification is complete.";
         next='创建退款或换货工单' }
      @{ style='合规告知'; zh="关于您的退款申请，我们说明一下处理口径：依据 $CountryZh 的相关规定，商品不符合约定时您享有退款或换货的权利，退回商品的运费承担方为：$p。我们会依照这一口径为您执行。";
         en="Regarding your refund request, here is our handling position: under the applicable rules in $CountryZh, when goods do not conform you are entitled to a refund or exchange. Responsibility for return shipping: $p. We will proceed on that basis.";
         next='在工单中记录适用政策依据' }
    )
    'quality_defect' = @(
      @{ style='安抚致歉'; zh="非常抱歉，这件商品的质量问题给您添麻烦了，这是我们的责任。您可以选择全额退款或我们重新补发一件，两种方式的运费都由我们承担。请发一张实物照片给我们，马上为您安排。";
         en="We are very sorry the quality issue caused you trouble. This is on us. You may choose a full refund or a replacement, and shipping is covered either way. Please send us a photo and we will arrange it immediately.";
         es="Lamentamos mucho las molestias. Las manchas o el defecto son responsabilidad nuestra. Hemos registrado su incidencia, abrimos su caso y le informaremos de la solución lo antes posible.";
         next='请客户提供实物照片' }
      @{ style='专业答疑'; zh="关于您反馈的质量问题，我们说明一下判定口径：按照我们的质检标准，此类情况属于可判定为瑕疵的范围。为准确核对，需要您提供商品标签与实物照片，我们收到后会给出明确的处理方案。";
         en="About the quality issue you reported, here is how we assess it: under our QC standard this falls within the range that can be classed as a defect. To verify accurately we need the care label and a photo, then we will give you a clear resolution.";
         next='索取标签与实物照片' }
      @{ style='纠纷调解'; zh="我们非常重视您反馈的问题。按照 $CountryZh 的相关规定，商品存在瑕疵时您可以选择退款或换货，$d，退回运费由我们承担。我们正在与相关方核实，同时已先行为您开通处理通道。";
         en="We take your issue seriously. Under the applicable rules in $CountryZh, when an item is defective you may choose a refund or exchange, $d, and return shipping is on us. We are verifying with the relevant party and have already opened a case for you.";
         next='创建工单并标注运费承担方' }
    )
    'color_diff' = @(
      @{ style='安抚致歉'; zh="非常抱歉给您带来的困扰。服装在拍摄光线与屏幕显示下可能存在色差，但如果实物与页面描述差异明显，这确实是我们需要负责的问题。请您发一张自然光下的实物照片，我们为您安排换货或退款。";
         en="We are sorry for the trouble. Some colour variation is possible between studio lighting and your screen, but if the item clearly differs from the listing that is on us. Please send a photo in natural light and we will arrange an exchange or refund.";
         next='请客户提供自然光照片' }
      @{ style='专业答疑'; zh="关于色差，说明一下行业口径：同一批次布料在不同光线与显示设备下会有轻微视觉差异，这一般不属于质量问题；但若与页面描述的颜色明显不符，则属于不符合约定，您可以要求换货或退款。";
         en="On colour variation, here is the industry position: the same fabric batch can look slightly different under different lighting and screens, which is normally not a defect. However, if it clearly differs from the listing description, the goods do not conform and you may request an exchange or refund.";
         next='核对页面描述与实物照片' }
      @{ style='合规告知'; zh="依据 $CountryZh 的相关规定，商品与描述不符时您有权要求换货或退款。我们会按此口径处理您的申请，退回运费由我们承担。";
         en="Under the applicable rules in $CountryZh, when goods do not match the description you are entitled to an exchange or refund. We will handle your request on that basis, and return shipping is on us.";
         next='记录政策依据并推进换货' }
    )
    'sizing' = @(
      @{ style='专业答疑'; zh="非常抱歉尺码不合适。我们的尺码表是按服装平铺实测标注的，不同版型之间会存在 1-2cm 的正常误差。方便的话请把您的实际胸围/腰围数据告诉我，我帮您核对最合适的尺码。";
         en="Sorry the size did not work out. Our size chart is based on flat-lay measurements, and a 1-2 cm tolerance is normal between cuts. If you share your actual bust/waist measurements I will check the best size for you.";
         next='索取客户实测尺寸' }
      @{ style='安抚致歉'; zh="很抱歉给您带来不便。尺码不合适我们可以为您安排换货，请在平台上发起换货申请并选择需要的尺码，退换运费由我们承担。";
         en="We are sorry for the inconvenience. If the size is not right we can arrange an exchange. Please raise the exchange request on the platform and choose the size you need; shipping is on us.";
         next='引导在平台发起换货' }
      @{ style='营销促单'; zh="感谢您的反馈！如果这件尺码不合适，我们可以为您换成更合适的码，同时如果还想要同系列的其他款式，可以一起下单，我们为您申请组合优惠。";
         en="Thanks for your feedback. If this size is not right we can swap it for a better fit, and if you would like another style from the same range we can order them together and apply a bundle offer for you.";
         next='推荐同系列款式' }
    )
    'logistics' = @(
      @{ style='安抚致歉'; zh="感谢您的耐心等待，让您久等了非常抱歉。我们正在为您查询包裹的最新状态，稍后会同步给您。如果物流确认异常，我们会立即为您安排补偿方案。";
         en="Thank you for your patience, and we are sorry for the wait. We are checking the latest status of your parcel and will update you shortly. If the carrier confirms an issue we will arrange a resolution for you immediately.";
         next='查询物流轨迹并同步' }
      @{ style='专业答疑'; zh="关于物流状态，说明一下流程：跨境包裹在清关环节可能需要额外时间，这期间轨迹会暂时不更新。我这边查到的最新节点是：{node}。我们会持续跟进并把最新进展告知您。";
         en="On the shipping status: cross-border parcels can need extra time at customs clearance, during which tracking may pause. The latest checkpoint I can see is: {node}. We will keep following up and keep you posted.";
         next='拉取最新物流节点' }
      @{ style='合规告知'; zh="关于您的包裹，我们如实说明：目前物流轨迹显示的状态是「{node}」，我们不会向您承诺具体的到达日期。若超出平台规定的时效，您可以依规申请退款，我们会配合处理。";
         en="About your parcel, here is the accurate position: tracking currently shows '{node}'. We will not promise a specific delivery date. If the platform's delivery window is exceeded you may apply for a refund under the rules, and we will cooperate.";
         next='记录时效并评估平台规则' }
    )
    'negative_review' = @(
      @{ style='纠纷调解'; zh="非常抱歉没有让您满意，您反馈的情况我们已经上报，会由专人跟进核实。我们希望在平台规则内把事情解决好，也请您给我们一个处理的机会。";
         en="We are truly sorry we did not meet your expectations. Your case has been escalated and a dedicated colleague will look into it. We want to resolve this within the platform rules and would appreciate the chance to put it right.";
         next='转主管并记录投诉点' }
      @{ style='安抚致歉'; zh="非常抱歉给您带来这么差的体验。您的意见我们完全接受，已经记录并安排专人跟进。我们会在核实后尽快给您一个明确答复。";
         en="We are very sorry for this poor experience. We fully accept your feedback, have logged it, and assigned a dedicated colleague. We will come back to you with a clear answer as soon as we have verified.";
         next='安排专人跟进并回访' }
      @{ style='合规告知'; zh="我们理解您的不满。关于评价与售后处理，平台规则下两者是分开的：我们会按规则处理您的售后诉求，不会以任何条件干预您的评价。";
         en="We understand your dissatisfaction. Under platform rules, reviews and after-sales handling are separate: we will handle your after-sales request under the rules and will not ask you to change your review under any condition.";
         next='按规则处理并避免评价交换' }
    )
    'product_info' = @(
      @{ style='专业答疑'; zh="关于这款商品，为您说明：面料成分以吊牌标注为准，建议按洗标指示低温手洗、避免长时间浸泡与暴晒。同类面料在高温或机洗强力甩干的条件下存在缩水可能，这是面料特性而非质量问题。";
         en="About this item: the fabric composition is as stated on the care label. We recommend a cool hand wash and avoiding long soaking or direct sun. Like fabrics of this type may shrink under high heat or a strong spin cycle; that is a property of the material rather than a defect.";
         next='核对吊牌与洗标信息' }
      @{ style='合规告知'; zh="关于面料与安全的说明：我们的商品按出口市场的标准生产，童装类商品在绳带与阻燃方面符合对应标准要求。具体成分比例请您以商品吊牌与检测报告为准，我们不作超出标注范围的宣称。";
         en="On fabric and safety: our items are produced to the standards of the destination market, and childrenswear complies with the relevant cord and flammability requirements. Please refer to the care label and test report for exact composition; we make no claims beyond what is documented.";
         next='提供吊牌与检测报告信息' }
      @{ style='营销促单'; zh="感谢您对我们商品的关注！这款是我们的常青款，面料和版型都经过多次打磨。如果您在几个款式之间犹豫，可以告诉我您的穿着场景，我帮您推荐更合适的搭配。";
         en="Thank you for your interest in our item. This is one of our staple styles, refined over several seasons in both fabric and cut. If you are choosing between styles, tell me how you plan to wear it and I will suggest a better match.";
         next='询问穿着场景并推荐' }
    )
    'customs' = @(
      @{ style='合规告知'; zh="关于关税与清关，说明一下：跨境包裹的进口关税由目的地海关依当地规定征收，我们无法代替海关承诺是否征税或具体金额。若包裹在清关环节滞留，我们会配合提供所需单据。";
         en="On customs duty and clearance: import duty is levied by the destination customs authority under local rules. We cannot promise on customs' behalf whether duty applies or how much it will be. If a parcel is held at clearance we will provide the documents required.";
         next='提供清关所需单据' }
      @{ style='专业答疑'; zh="关于清关流程：包裹需要经过目的地海关查验，常见的滞留原因是收件信息不全或需要补充申报。请您确认收件电话与地址是否正确，并留意海关或快递方的通知。";
         en="On the clearance process: parcels pass through destination customs inspection. Common causes of delay are incomplete recipient details or a need for supplementary declaration. Please confirm your phone number and address, and watch for notifications from customs or the carrier.";
         next='核对收件信息' }
      @{ style='安抚致歉'; zh="很抱歉给您带来不便。清关延误不在我们能直接控制的范围内，但我们会帮您跟进并向承运方确认情况，有进展第一时间告知您。";
         en="We are sorry for the inconvenience. Clearance delays are not something we directly control, but we will follow up on your behalf and check with the carrier, and will let you know as soon as there is progress.";
         next='向承运方发起查询' }
    )
    'repurchase' = @(
      @{ style='营销促单'; zh="很高兴您喜欢我们的商品！这款目前有现货，同系列还有几个相关款式，可以一起下单。如果数量较多，我可以帮您申请一个组合优惠。";
         en="Glad you like our item. This style is in stock, and there are a few related pieces in the same range you could order together. If you are buying several, I can apply for a bundle offer for you.";
         next='提供现货与搭配建议' }
      @{ style='专业答疑'; zh="关于补货：这款目前的库存与可选颜色、尺码我可以帮您确认。如果您常用的尺码暂时缺货，也可以告诉我，到货后我第一时间通知您。";
         en="On restocking: I can confirm current stock, colours and sizes for you. If your usual size is temporarily out, let me know and I will notify you as soon as it is back.";
         next='查询库存与到货时间' }
      @{ style='安抚致歉'; zh="感谢您的支持！如果您对这次购买还有任何顾虑，我们可以先把它处理好，再谈下一单，不着急。";
         en="Thank you for your support. If you still have any concerns about this purchase, let us settle those first before talking about the next order. No rush.";
         next='先确认本次购买体验' }
    )
    'invoice' = @(
      @{ style='合规告知'; zh="关于发票：我们会在核实订单信息后按平台流程为您开具，具体可开具的类型以平台与当地税务规定为准。请您提供发票抬头与税号信息。";
         en="On invoices: we will issue it through the platform process after verifying your order. The available types depend on the platform and local tax rules. Please provide the invoice title and tax number.";
         next='索取抬头与税号' }
      @{ style='专业答疑'; zh="关于开票流程：订单完成后可以申请，开具后会在平台上同步给您。如果您需要的是当地税务格式的发票，请告知具体国家与要求，我帮您确认能否满足。";
         en="On the invoicing process: you can apply after the order is completed, and it will be delivered to you on the platform. If you need an invoice in a specific local tax format, tell me the country and requirement and I will confirm whether it is possible.";
         next='确认开票类型与要求' }
      @{ style='安抚致歉'; zh="抱歉让您多问了一次。您的开票需求我已经记录，会转给对应同事跟进，处理进度我会同步给您。";
         en="Sorry you had to ask again. I have logged your invoicing request and will pass it to the right colleague, and will keep you updated on progress.";
         next='转财务并同步进度' }
    )
    'payment' = @(
      @{ style='合规告知'; zh="关于支付问题：我们不会在对话中向您索取任何敏感支付信息。请您在平台内查看订单支付状态，如有重复扣款，平台会在核实后原路退回。";
         en="On the payment issue: we will never ask for your card number, password or verification code in chat. Please check the payment status inside the platform. If you were charged twice, the platform will refund it to the original payment method after verification.";
         next='引导在平台内核对支付状态' }
      @{ style='专业答疑'; zh="关于扣款：支付失败通常与发卡行的限额或网络有关，资金一般会在 1-3 个工作日自动解冻。建议您先在平台订单页确认最终支付状态。";
         en="On the charge: a failed payment is usually related to a card limit or network issue, and the funds normally release automatically within 1-3 business days. Please first confirm the final payment status on the order page.";
         next='核对订单支付状态' }
      @{ style='安抚致歉'; zh="很抱歉给您带来困扰。支付类问题涉及资金安全，我帮您转到平台客服通道处理，这样最快也最安全。";
         en="Sorry for the trouble. Payment issues involve fund security, so I will route you to the platform support channel — that is both the fastest and the safest route.";
         next='转平台支付客服' }
    )
    'complaint_service' = @(
      @{ style='安抚致歉'; zh="非常抱歉让您觉得被忽视了，这是我们的问题。您的问题我现在就接手处理，并会明确告诉您下一步和时间点，不会再让您等。";
         en="We are very sorry you felt ignored — that is on us. I am taking over your case now and will give you a clear next step and timeline. You will not be left waiting again.";
         next='立即接手并给出时间点' }
      @{ style='纠纷调解'; zh="非常抱歉我们的服务没有达到应有的水准。您反馈的情况我已上报主管，会有人专门跟进核实，并在核实后给您答复。";
         en="We are sorry our service fell short of the standard it should meet. I have escalated your case to my supervisor and someone will follow up specifically, and get back to you once verified.";
         next='上报主管并回访' }
      @{ style='合规告知'; zh="感谢您指出问题。我们会按平台的服务规范自查这次沟通记录，并把改进结果反馈给您。";
         en="Thank you for pointing this out. We will review this conversation against the platform's service standards and feed the outcome back to you.";
         next='调取会话记录自查' }
    )
    'exchange' = @(
      @{ style='安抚致歉'; zh="很抱歉给您带来不便。换货我们可以为您安排，请在平台发起换货申请并选择需要的规格，运费由我们承担。";
         en="Sorry for the inconvenience. We can arrange an exchange for you. Please raise the request on the platform and choose the specification you need; shipping is on us.";
         next='引导发起换货申请' }
      @{ style='专业答疑'; zh="关于换货流程：您提交申请后，我们会尽快审核并安排寄出。为保证准确，请确认要更换的颜色与尺码。";
         en="On the exchange process: once you submit the request we will review it and dispatch as soon as possible. To be accurate, please confirm the colour and size you want to switch to.";
         next='确认目标颜色与尺码' }
      @{ style='营销促单'; zh="换货的同时，如果同系列还有其他您喜欢的款式，可以一起处理，避免多次等待物流。";
         en="While we handle the exchange, if there is another style in the same range you like, we can process them together to save you a second wait for shipping.";
         next='推荐同系列款式' }
    )
    'other' = @(
      @{ style='安抚致歉'; zh="感谢您的留言，您反馈的问题我们已经收到，正在为您核实。我们会尽快回复您一个明确的处理方案。";
         en="Thank you for your message. We have received your question and are checking it. We will get back to you shortly with a clear resolution.";
         next='核实问题并回复' }
      @{ style='专业答疑'; zh="为了让您的问题得到准确答复，我需要先核对一下订单信息。请您提供订单号或截图，我这边马上为您查询。";
         en="To answer accurately I first need to check your order details. Please provide the order number or a screenshot and I will look it up right away.";
         next='索取订单号' }
      @{ style='合规告知'; zh="关于您的问题，我们会在核实事实与适用规则后给您答复，不会在信息不完整的情况下作出承诺。";
         en="On your question, we will reply after verifying the facts and the applicable rules. We will not make commitments while the information is incomplete.";
         next='核实事实与适用规则' }
    )
  }

  if ($all.ContainsKey($Intent)) { return $all[$Intent] }
  return $all['other']
}

function New-Candidates {
  param($Analysis, $Retrieval, $Rewrite, [string]$Country='UNKNOWN')
  $countryZh = Get-CountryZh -Code $Country
  $days = ''; $payer = ''
  $pol = @($Retrieval.evidence | Where-Object { $_.country -eq $Country -or $_.country -eq 'EU' } | Sort-Object score -Descending | Select-Object -First 1)
  if ($pol.Count -gt 0) {
    $days = "$($pol[0].return_days) 天"
    if ($pol[0].return_days -eq 'NA' -or [string]::IsNullOrWhiteSpace($pol[0].return_days)) { $days = '' }
    $payer = $pol[0].shipping_payer
  }

  $templates = Get-CandidateTemplates -Intent $Analysis.primary_intent -CountryZh $countryZh -Days $days -Payer $payer
  $candidates = @()
  $i = 0
  foreach ($t in $templates) {
    $i++
    $zh = $t.zh
    $en = $t.en
    $es = ''
    if ($t.ContainsKey('es')) { $es = $t.es }
    if ($zh -match '\{node\}') { $zh = $zh -replace '\{node\}', '运输途中' }
    if ($en -match '\{node\}') { $en = $en -replace '\{node\}', 'in transit' }

    $cited = @($Retrieval.evidence | Select-Object -First 2 | ForEach-Object { $_.doc_id })

    $candidates += [pscustomobject]@{
      candidate_id     = "c$i"
      style            = $t.style
      text_zh          = $zh
      text_en          = $en
      text_es          = $es
      cited_evidence   = $cited
      risk_notes       = @()
      unsupported      = ($Retrieval.coverage -eq 'insufficient')
      next_action_hint = $t.next
    }
  }
  return $candidates
}

# ---------------------------------------------------------------------
# 把模型返回的 candidates 归一化成内部结构
#   模型输出字段可能与契约有出入（缺字段、多字段、类型不对），
#   这里做一次兜底，保证下游合规校验与前端渲染拿到的一定是完整结构。
# ---------------------------------------------------------------------
function ConvertFrom-ModelCandidates {
  param($Raw, $Retrieval)
  $out = @()
  $i = 0
  foreach ($c in $Raw) {
    $i++
    $cid = "c$i"
    if ($c.PSObject.Properties.Name -contains 'candidate_id' -and -not [string]::IsNullOrWhiteSpace([string]$c.candidate_id)) {
      $cid = [string]$c.candidate_id
    }
    $style = ''
    if ($c.PSObject.Properties.Name -contains 'style') { $style = [string]$c.style }
    $zh = ''
    if ($c.PSObject.Properties.Name -contains 'text_zh') { $zh = [string]$c.text_zh }
    $tgt = ''
    if ($c.PSObject.Properties.Name -contains 'text_target') { $tgt = [string]$c.text_target }
    elseif ($c.PSObject.Properties.Name -contains 'text_en') { $tgt = [string]$c.text_en }

    $cited = @()
    if ($c.PSObject.Properties.Name -contains 'cited_evidence') { $cited = @($c.cited_evidence) }
    if ($cited.Count -eq 0) { $cited = @($Retrieval.evidence | Select-Object -First 2 | ForEach-Object { $_.doc_id }) }

    $notes = @()
    if ($c.PSObject.Properties.Name -contains 'risk_notes') { $notes = @($c.risk_notes) }

    $unsup = ($Retrieval.coverage -eq 'insufficient')
    if ($c.PSObject.Properties.Name -contains 'unsupported') { $unsup = [bool]$c.unsupported }

    $next = ''
    if ($c.PSObject.Properties.Name -contains 'next_action_hint') { $next = [string]$c.next_action_hint }

    $out += [pscustomobject]@{
      candidate_id     = $cid
      style            = $style
      text_zh          = $zh
      text_en          = $tgt
      text_es          = ''
      cited_evidence   = $cited
      risk_notes       = $notes
      unsupported      = $unsup
      next_action_hint = $next
    }
  }
  return $out
}

# ---------------------------------------------------------------------
# 主控：串流程 + 汇总 + 转人工判定
# ---------------------------------------------------------------------
function Invoke-Pipeline {
  param(
    [Parameter(Mandatory)][string]$Text,
    [string]$Country = 'UNKNOWN',
    [string]$Platform = 'unknown',
    [string]$Category = 'unknown',
    [string]$Source = 'text',
    [string]$OcrLanguage = ''
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $modelUsed = @()

  # --- A1 语言识别 ---
  $lang = Get-LanguageGuess -Text $Text

  # --- A1' 翻译：若已接入模型则用模型，否则走本地术语命中 ---
  # Invoke-LLM 在 provider=local 或未配密钥时返回 $null，链路自动回退，不会断
  $modelTranslation = $null
  if ($lang -ne 'zh') {
    $modelTranslation = Invoke-LLM -Task 'translate' -Params @{
      system_prompt = (Get-AgentPrompt -Name 'translate')
      text          = $Text
      temperature   = 0.1
    }
    if ($modelTranslation) { $modelUsed += 'translate(模型)' }
  }

  # --- A2 意图情绪 ---
  $analysis = Get-IntentAnalysis -Text $Text -Country $Country

  # --- A3 查询改写 ---
  $rewrite = Get-QueryRewrite -Analysis $analysis -Country $Country -Platform $Platform -Category $Category
  $rewrite.filters.lang = $lang

  # --- 检索 ---
  $retrieval = Invoke-Retrieval -Rewrite $rewrite -Analysis $analysis -Country $Country -Platform $Platform

  # --- 术语命中（真实词库） ---
  $glossaryHits = @()
  if ($lang -eq 'zh') { $glossaryHits = @(Get-GlossaryHits -Text $Text) }
  else                { $glossaryHits = @(Get-GlossaryHitsByForeign -Text $Text) }

  # --- A4 话术生成：优先模型，失败/未接入则回退模板 ---
  $candidates = @()
  $generatedBy = 'local-template'
  $modelGen = $null
  if ((Get-ModelConfig).provider -ne 'local') {
    $ctxLines = @()
    $ctxLines += "客户问题（中文/原文）：$Text"
    $ctxLines += "主意图：$($analysis.primary_intent)   情绪：$($analysis.emotion.polarity)/强度$($analysis.emotion.intensity)   紧急度：$($analysis.urgency)"
    $ctxLines += "目标国家：$Country   平台：$Platform   品类：$Category"
    $ctxLines += "检索覆盖度：$($retrieval.coverage)"
    $ctxLines += "检索证据："
    foreach ($e in $retrieval.evidence) { $ctxLines += "  [$($e.doc_id)] $($e.title)：$($e.snippet)" }
    $ctxLines += "主推风格：$($analysis.suggested_style)"
    $modelGen = Invoke-LLM -Task 'generate' -Params @{
      system_prompt = (Get-AgentPrompt -Name 'generate')
      context       = ($ctxLines -join "`n")
      temperature   = 0.7
    }
  }
  if ($modelGen -and $modelGen.PSObject.Properties.Name -contains 'candidates' -and @($modelGen.candidates).Count -gt 0) {
    $candidates = @(ConvertFrom-ModelCandidates -Raw @($modelGen.candidates) -Retrieval $retrieval)
    $generatedBy = 'model'
    $modelUsed += 'generate(模型)'
  } else {
    $candidates = @(New-Candidates -Analysis $analysis -Retrieval $retrieval -Rewrite $rewrite -Country $Country)
  }

  # --- A5 合规校验（真实正则） ---
  $compliance = @()
  $survivors = @()
  foreach ($c in $candidates) {
    $chk = Invoke-ComplianceCheck -Text $c.text_zh -Country $Country -Platform $Platform
    $compliance += [pscustomobject]@{
      candidate_id = $c.candidate_id
      style        = $c.style
      decision     = $chk.decision
      violations   = $chk.violations
      revised_text = $null
    }
    if ($chk.decision -ne 'reject') { $survivors += $c }
  }

  # --- 排序与推荐 ---
  # 权重与设计文档一致：合规分优先（pass 1.0 > revise 0.6）。
  # 关键：PowerShell 的 Sort-Object 不是稳定排序，只按一个键排会让同分项随机换位，
  #       导致「同一输入两次运行推荐不同的话术」。所以必须带上原始序号做次级键。
  $decisionOf = @{}
  foreach ($cf in $compliance) { $decisionOf[$cf.candidate_id] = $cf.decision }

  $ranked = @()
  for ($i = 0; $i -lt $survivors.Count; $i++) {
    $s = $survivors[$i]
    $score = 0
    if ($decisionOf[$s.candidate_id] -eq 'pass') { $score += 0 } else { $score += 10 }
    if ($analysis.emotion.intensity -ge 4 -and $s.style -eq '营销促单') { $score += 100 }
    $ranked += [pscustomobject]@{ score = $score; idx = $i; cand = $s }
  }
  $survivors = @($ranked | Sort-Object -Property score, idx | ForEach-Object { $_.cand })

  $recommended = ''
  if ($survivors.Count -gt 0) { $recommended = $survivors[0].candidate_id }
  $replyZh = ''; $replyEn = ''
  if ($survivors.Count -gt 0) { $replyZh = $survivors[0].text_zh; $replyEn = $survivors[0].text_en }

  # --- 转人工判定 ---
  $needHuman = $false; $reason = $null
  if ($analysis.urgency -eq 'critical')                    { $needHuman = $true; $reason = 'critical_urgency' }
  elseif ($analysis.emotion.polarity -eq 'negative' -and $analysis.emotion.intensity -ge 4) { $needHuman = $true; $reason = 'escalated_emotion' }
  elseif ($retrieval.coverage -eq 'insufficient')          { $needHuman = $true; $reason = 'insufficient_knowledge' }
  elseif ($survivors.Count -eq 0)                          { $needHuman = $true; $reason = 'all_candidates_rejected' }
  elseif (@($analysis.risk_flags | Where-Object { $_ -in @('legal_risk','platform_intervention_risk','chargeback_risk') }).Count -gt 0) { $needHuman = $true; $reason = 'platform_risk' }
  elseif ($analysis.need_human_hint)                       { $needHuman = $true; $reason = 'escalated_emotion' }

  $handoff = $null
  if ($needHuman) {
    $rejected = @()
    foreach ($c in $candidates) {
      $cf = $compliance | Where-Object { $_.candidate_id -eq $c.candidate_id } | Select-Object -First 1
      if ($cf -and $cf.decision -eq 'reject') {
        $r0 = @($cf.violations | Select-Object -First 1)
        $rejected += [pscustomobject]@{
          text_zh = $c.text_zh
          rule_id = $(if ($r0.Count -gt 0) { $r0[0].rule_id } else { '' })
          reason  = $(if ($r0.Count -gt 0) { $r0[0].reason } else { '' })
        }
      }
    }
    $handoff = [pscustomobject]@{
      customer_text_raw   = $Text
      analysis_summary    = "$($analysis.primary_intent_zh) / 情绪 $($analysis.emotion.polarity)-$($analysis.emotion.intensity) / 紧急度 $($analysis.urgency)"
      policy_evidence     = @($retrieval.evidence | Select-Object -First 3 | ForEach-Object { [pscustomobject]@{ doc_id=$_.doc_id; title=$_.title; effective_date=$_.effective_date } })
      rejected_candidates = $rejected
      suggested_next_step = '人工核对政策依据后再回复，避免就直接责任归属或金额作承诺'
    }
  }

  $sw.Stop()

  return [pscustomobject]@{
    trace_id = ('tr_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '_' + (Get-Random -Minimum 1000 -Maximum 9999))
    input    = [pscustomobject]@{
      text = $Text; source = $Source; country = $Country; platform = $Platform
      category = $Category; detected_lang = $lang; ocr_language = $OcrLanguage
    }
    translation = [pscustomobject]@{
      detected_lang = $lang
      status = $(
        if ($lang -eq 'zh') { 'skipped（原文已是中文）' }
        elseif ($modelTranslation) { '由模型翻译（翻译 Agent）' }
        else { '本地演示未接入翻译模型，下方分析基于原文；接入千帆后由翻译 Agent 输出中文译文' }
      )
      translated_text = $(if ($modelTranslation -and $modelTranslation.PSObject.Properties.Name -contains 'translated_text') { [string]$modelTranslation.translated_text } else { '' })
      glossary_hits = $glossaryHits
    }
    analysis  = $analysis
    retrieval = [pscustomobject]@{
      queries  = $rewrite.queries
      filters  = $rewrite.filters
      kb_route = $rewrite.kb_route
      evidence = $retrieval.evidence
      coverage = $retrieval.coverage
    }
    candidates = $candidates
    compliance = $compliance
    final = [pscustomobject]@{
      recommended_candidate_id = $recommended
      reply_text_zh = $replyZh
      reply_text_en = $replyEn
      next_actions  = @($survivors | Select-Object -First 1 | ForEach-Object { $_.next_action_hint })
    }
    escalation = [pscustomobject]@{ need_human = $needHuman; reason = $reason; handoff_packet = $handoff }
    meta = [pscustomobject]@{
      latency_ms     = $sw.ElapsedMilliseconds
      mode           = (Get-ModelStatus).mode
      generated_by   = $generatedBy
      model_used     = $modelUsed
      degraded_nodes = @(
        if ($lang -ne 'zh' -and -not $modelTranslation) { 'translate_agent（未接入，本地术语命中）' }
        if ($generatedBy -eq 'local-template') { 'generate_agent（未接入，本地模板）' }
      )
    }
  }
}
