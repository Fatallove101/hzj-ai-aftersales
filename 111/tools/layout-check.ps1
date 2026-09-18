# =====================================================================
# 111/tools/layout-check.ps1
# 用无头浏览器真实验证工作台布局（不靠推理，靠测量）
#
# 背景：之前沙箱挡着命名管道，Chromium 起不来，CSS 布局只能靠推理。
#       现在能跑了，就把"布局会不会被裁切""该滚的能不能滚"变成自动化断言。
#
# 做法：把真实 index.html 复制一份，注入一段测量脚本，
#       用真实 app.js 的 render() 渲染 3 条长文本候选，
#       再用无头 Edge 量出每列/每个滚动容器的真实高度。
#
# 用法： powershell -ExecutionPolicy Bypass -File tools\layout-check.ps1
# =====================================================================

param(
  [int]$Width = 1440,
  [int]$Height = 900,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$WebDir = Join-Path $Root 'web'
# $Server 在下面按"专用端口"动态赋值，不要在这里写死 8799

$Edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Edge) { Write-Host "找不到 Edge，跳过布局检查" -ForegroundColor Yellow; exit 0 }

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  工作台布局实测（无头 Edge）" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------
# 服务：永远用本工具自己起的实例，固定从本目录的 server.ps1 起。
#
# 为什么不复用已经在跑的 8799：
#   如果有人已经跑着另一个副本的服务（比如 A 目录在跑，本工具从 B 目录启动），
#   本工具会把测试页写进 B\web，而 8799 上的服务其实在读 A\web →
#   返回 404 → 拿不到测量结果 → 脚本静默失败，排查起来很费时间。
#   自己起一个专用端口就没有这个问题。
# ---------------------------------------------------------------------
function Find-FreePort {
  foreach ($p in (8801..8830)) {
    $l = $null
    try {
      $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
      $l.Start(); $l.Stop(); return $p
    } catch { if ($l) { try { $l.Stop() } catch {} } }
  }
  return 0
}

$Port   = Find-FreePort
if ($Port -eq 0) { Write-Host "  找不到空闲端口，无法进行布局检查" -ForegroundColor Red; exit 1 }
$Server = "http://127.0.0.1:$Port"

Write-Host ("  启动专用服务实例（端口 {0}，目录 {1}）…" -f $Port, $Root) -ForegroundColor DarkGray
$tempServer = Start-Process -FilePath "powershell" `
  -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$Root\server.ps1","-Port","$Port","-NoBrowser" `
  -PassThru -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 700
  try { $null = Invoke-RestMethod "$Server/api/health" -TimeoutSec 3; $ready = $true; break } catch {}
}
if (-not $ready) {
  Write-Host "  ✕ 专用服务起不来，请先单独跑一次 server.ps1 看报错" -ForegroundColor Red
  if ($tempServer) { try { Stop-Process -Id $tempServer.Id -Force } catch {} }
  exit 1
}
Write-Host "  服务就绪" -ForegroundColor Green

$testJs   = Join-Path $WebDir '_layouttest.js'
$testHtml = Join-Path $WebDir '_layouttest.html'

try {
  # ---------- 注入的测量脚本 ----------
  $js = @'
/* 布局测量：用真实 render() 渲染长文本，再量真实高度 */
(function () {
  function mock() {
    var long = 'We are very sorry the quality issue caused you trouble. This is on us. ' +
               'You may choose a full refund or a replacement, and shipping is covered either way. ' +
               'Please send us a photo of the item and we will arrange it immediately. ' +
               'Our team will follow up within the platform rules and keep you updated at every step. ';
    var cands = [], comps = [];
    ['安抚致歉', '专业答疑', '纠纷调解'].forEach(function (st, i) {
      cands.push({
        candidate_id: 'c' + (i + 1), style: st,
        text_zh: '非常抱歉，这件商品的质量问题给您添麻烦了，这是我们的责任。您可以选择全额退款或我们重新补发一件，两种方式的运费都由我们承担。请发一张实物照片给我们，马上为您安排。',
        text_en: long, text_es: '',
        cited_evidence: ['ES-TRLGDCU-118'], risk_notes: [], unsupported: false,
        next_action_hint: '请客户提供实物照片'
      });
      comps.push({ candidate_id: 'c' + (i + 1), style: st, decision: i === 1 ? 'revise' : 'pass',
        violations: i === 1 ? [{ rule_id: 'R018', category: 'cross_border', severity: 'revise',
          title: '欧盟订单须体现14天无理由退货权', span: '（缺少法定应告知内容）',
          reason: '涉及退货场景未告知欧盟法定14天无理由退货权', suggestion: '补充14天权利告知' }] : [],
        revised_text: null });
    });
    return {
      trace_id: 'tr_layout_test', input: { text: 'x', source: 'text', country: 'ES', platform: 'tiktok_shop', detected_lang: 'en' },
      translation: { detected_lang: 'en', status: 'test', glossary_hits: [] },
      analysis: {
        intents: [{ label: 'quality_defect', label_zh: '质量投诉', confidence: 0.96 }],
        primary_intent: 'quality_defect', primary_intent_zh: '质量投诉',
        emotion: { polarity: 'negative', intensity: 4, signals: ['stain', 'refund'] },
        urgency: 'critical', risk_flags: ['platform_intervention_risk'], suggested_style: '安抚致歉'
      },
      retrieval: {
        queries: ['q1', 'q2', 'q3'], kb_route: ['policy_kb', 'case_kb'], coverage: 'sufficient',
        evidence: [{ kb: 'policy_kb', doc_id: 'ES-TRLGDCU-118', title: '西班牙商品瑕疵救济顺位',
          snippet: '商品不符合约定时，消费者有权要求修复或更换；不能修复更换时可要求降价或解除合同。'.repeat(3),
          score: 0.87, effective_date: '2014-03-27', stale: false }]
      },
      candidates: cands, compliance: comps,
      final: { recommended_candidate_id: 'c1', reply_text_zh: cands[0].text_zh, reply_text_en: long,
        next_actions: ['请客户提供实物照片'], knowledge_gaps: [] },
      escalation: { need_human: true, reason: 'critical_urgency',
        handoff_packet: { customer_text_raw: 'x', analysis_summary: '质量投诉 / negative-4 / critical',
          policy_evidence: [{ doc_id: 'ES-TRLGDCU-118', title: '西班牙商品瑕疵救济顺位', effective_date: '2014-03-27' }],
          rejected_candidates: [], suggested_next_step: '人工核对政策依据后再回复' } },
      routing: { group: '售后组', sla: '4h', risk: '超 ¥500 升级主管', source: 'ecommerce-intent-routing' },
      calming: { level: 3, action: '致歉 + 承认体验不好 + 给选项', forbidden: '反复道歉、解释原因', source: 'customer-reply-craft' },
      skill_application: [
        '组装提示词：基础 5362 字符 + 技能正文 2409 字符 = 7803 字符',
        '工单路由 → 分派「售后组」，SLA 4h',
        '情绪策略 → 3 级：致歉 + 承认体验不好 + 给选项'
      ],
      meta: { latency_ms: 812, mode: 'local-fallback', generated_by: 'local-template', model_used: [],
              skills: ['after-sales-qa', 'customer-reply-craft', 'ecommerce-intent-routing', 'cross-border-escalation'],
              composed_prompt_chars: 7803, degraded_nodes: [] }
    };
  }

  function measure(name, el) {
    if (!el) return { name: name, missing: true };
    var r = el.getBoundingClientRect();
    var st = getComputedStyle(el);
    // 只有"没有可滚动祖先"时，元素底部超出视口才算异常。
    // 位于滚动容器内部的元素本来就可能在折叠线下方 —— 那是可滚动的正常状态，
    // 不加这个判断会满屏误报"溢出视口"，反而掩盖真问题。
    var inScroller = false;
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      var ps = getComputedStyle(p);
      if (ps.overflowY === 'auto' || ps.overflowY === 'scroll' || ps.overflowY === 'hidden') { inScroller = true; break; }
    }
    return {
      name: name,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      rectH: Math.round(r.height),
      bottom: Math.round(r.bottom),
      overflowY: st.overflowY,
      minHeight: st.minHeight,
      scrollable: el.scrollHeight > el.clientHeight + 1,
      inScroller: inScroller,
      overflowsViewport: (!inScroller) && Math.round(r.bottom) > window.innerHeight + 1
    };
  }

  // 同步执行，不依赖 load / setTimeout —— 否则 --dump-dom 可能先拍快照
  window.__runLayoutTest = function () {
    var report = { viewport: { w: window.innerWidth, h: window.innerHeight }, items: [], errors: [] };
    try {
      render(mock());
    } catch (e) {
      report.errors.push('render() 抛异常: ' + e.message);
    }
    // 填一段含「AI 客服转人工」上下文的对话，验证三类发言人分类 + 便于截图
    var ta = document.getElementById('chatText');
    if (ta) {
      ta.value = 'AI客服: 您好，请问有什么可以帮您？\n' +
                 'Buyer: The dress arrived with stains and I want my money back\n' +
                 'AI客服: 很抱歉给您带来不便，我这边只能为您登记，具体方案需要售后专员处理。\n' +
                 'Buyer: I have been waiting 10 days already\n' +
                 'AI客服: 已为您转接人工客服，请稍候。\n' +
                 'Seller: So sorry, let me check your order\n' +
                 'Buyer: If you don\'t handle this I will complain to the platform';
      renderChat();
      var bs = document.querySelectorAll('.bubble');
      report.chatBubbles = bs.length;
      report.chatKinds = Array.prototype.map.call(bs, function (b) {
        return (b.className || '').replace('bubble ', '').trim();
      });
      report.logLines = document.querySelectorAll('.logline').length;
    }
    var cols = document.querySelectorAll('.col');
    for (var i = 0; i < cols.length; i++) report.items.push(measure('列' + (i + 1) + '(.col)', cols[i]));
    report.items.push(measure('中列-候选话术(#candidates)', document.querySelector('#candidates')));
    report.items.push(measure('右列-分析结果(#analysis)', document.querySelector('#analysis')));
    report.items.push(measure('中列卡片(.card-flush)', document.querySelector('.col-wide > .card-flush')));
    report.items.push(measure('三栏容器(.wb-cols)', document.querySelector('.wb-cols')));
    report.items.push(measure('运行日志(.logpanel)', document.querySelector('.logpanel')));
    report.items.push(measure('对话流(.chatview)', document.querySelector('.chatview')));
    report.items.push(measure('左侧导航(.sidebar)', document.querySelector('.sidebar')));

    // 双语卡片结构是否真的渲染出来了
    var blocks = document.querySelectorAll('.cand-lang');
    report.langBlocks = blocks.length;
    report.langLabels = [];
    for (var j = 0; j < blocks.length; j++) {
      var nm = blocks[j].querySelector('.lang-name');
      report.langLabels.push(nm ? nm.textContent : '(无标签)');
    }
    report.candCount = document.querySelectorAll('.cand').length;


    var pre = document.getElementById('layoutreport');
    pre.textContent = '@@@REPORT@@@' + JSON.stringify(report) + '@@@END@@@';
  };
})();
'@
  [System.IO.File]::WriteAllText($testJs, $js, (New-Object System.Text.UTF8Encoding($false)))

  $html = [System.IO.File]::ReadAllText((Join-Path $WebDir 'index.html'), (New-Object System.Text.UTF8Encoding($false)))
  # 注意顺序：<pre> 必须在脚本之前，否则脚本执行时 getElementById 拿不到它
  $html = $html.Replace('</body>',
    '<pre id="layoutreport" style="position:fixed;left:-99999px;top:0">pending</pre>' +
    '<script src="_layouttest.js"></script>' +
    '<script>window.__runLayoutTest();</script>' +
    '</body>')
  [System.IO.File]::WriteAllText($testHtml, $html, (New-Object System.Text.UTF8Encoding($false)))

  # ---------- 跑无头浏览器 ----------
  # Edge 会往 stderr 写大量无关日志；在 $ErrorActionPreference='Stop' 下
  # 这些原生命令的 stderr 会被当成致命错误，所以这里临时放宽。
  $prof = Join-Path $env:TEMP ("edge_" + [guid]::NewGuid().ToString('N'))
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $Edge --headless=new --disable-gpu --no-sandbox `
        --user-data-dir="$prof" --window-size="$Width,$Height" `
        --virtual-time-budget=6000 --dump-dom "$Server/_layouttest.html" 2>$null | Out-String
  } finally {
    $ErrorActionPreference = $prevEap
  }
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue

  $m = [regex]::Match($raw, '(?s)@@@REPORT@@@(.*?)@@@END@@@')
  if (-not $m.Success) {
    Write-Host "  ✕ 没拿到测量结果。浏览器输出片段：" -ForegroundColor Red
    Write-Host ($raw.Substring(0, [math]::Min(900, $raw.Length)))
    exit 1
  }
  $rep = $m.Groups[1].Value | ConvertFrom-Json

  # ---------- 输出 ----------
  Write-Host ("  视口 {0}x{1}   候选卡片 {2} 张   双语块 {3} 个" -f `
    $rep.viewport.w, $rep.viewport.h, $rep.candCount, $rep.langBlocks) -ForegroundColor White
  Write-Host ""
  Write-Host "  元素                                    高(client) 内容(scroll)     底部   可滚动  overflow-y" -ForegroundColor DarkGray
  foreach ($it in $rep.items) {
    if ($it.missing) { Write-Host ("  {0,-38} 找不到" -f $it.name) -ForegroundColor Red; continue }
    $flag = ''
    if ($it.overflowsViewport) { $flag = ' ← 溢出视口!' }
    Write-Host ("  {0,-38} {1,7} {2,11} {3,8} {4,7}  {5}{6}" -f `
      $it.name, $it.clientH, $it.scrollH, $it.bottom, $(if ($it.scrollable) { '是' } else { '否' }), $it.overflowY, $flag) `
      -ForegroundColor $(if ($it.overflowsViewport) { 'Red' } elseif ($it.scrollable) { 'Green' } else { 'Gray' })
  }

  # ---------- 断言 ----------
  Write-Host ""
  Write-Host "  --- 断言 ---" -ForegroundColor White
  $fail = 0
  function Assert($name, $cond, $detail) {
    if ($cond) { Write-Host ("    ✓ " + $name) -ForegroundColor Green }
    else { Write-Host ("    ✕ " + $name + $(if ($detail) { '  → ' + $detail } else { '' })) -ForegroundColor Red; $script:fail++ }
  }

  $cols = @($rep.items | Where-Object { $_.name -like '列*' })
  Assert "三列都不溢出视口" (@($cols | Where-Object { $_.overflowsViewport }).Count -eq 0)
  # 只要求"内容确实超出的列能滚"。
  # 大屏下左列内容正好装得下、不滚动，是正常行为，不该判失败。
  $needScroll = @($cols | Where-Object { $_.scrollH -gt $_.clientH })
  Assert "内容超出的列都可滚动" (@($needScroll | Where-Object { -not $_.scrollable }).Count -eq 0) `
    ("超出但不可滚: " + (@($needScroll | Where-Object { -not $_.scrollable } | ForEach-Object { $_.name }) -join ', '))

  $cand = $rep.items | Where-Object { $_.name -like '*#candidates*' }
  $anal = $rep.items | Where-Object { $_.name -like '*#analysis*' }
  # 候选话术必须能滚：它的内容一定比容器高（卡片不允许被压扁）
  Assert "候选话术列内容溢出且可滚动" ($cand -and $cand.scrollH -gt $cand.clientH -and $cand.scrollable) $(if ($cand) { "clientH=$($cand.clientH) scrollH=$($cand.scrollH)" })
  Assert "分析结果列可滚动" ($anal -and $anal.scrollable) $(if ($anal) { "clientH=$($anal.clientH) scrollH=$($anal.scrollH)" })
  # 关键回归：候选卡片若被 flex 压扁，scrollH 会等于 clientH（内容被裁掉却以为没溢出）
  Assert "候选卡片未被 flex 压扁（scrollH 大于 clientH）" ($cand -and $cand.scrollH -gt $cand.clientH) $(if ($cand) { "scrollH=$($cand.scrollH) clientH=$($cand.clientH)" })
  Assert "候选话术容器 overflow-y 是 auto/scroll" ($cand -and $cand.overflowY -match 'auto|scroll') $(if ($cand) { $cand.overflowY })
  Assert "分析结果容器 overflow-y 是 auto/scroll" ($anal -and $anal.overflowY -match 'auto|scroll') $(if ($anal) { $anal.overflowY })
  Assert "三栏容器不溢出视口" (-not ($rep.items | Where-Object { $_.name -like '*wb-cols*' }).overflowsViewport)
  Assert "render() 无异常" ($rep.errors.Count -eq 0) ($rep.errors -join '; ')
  $logp = $rep.items | Where-Object { $_.name -like '*logpanel*' }
  Assert "运行日志面板存在且不溢出视口" ($logp -and -not $logp.missing -and -not $logp.overflowsViewport)
  $chat = $rep.items | Where-Object { $_.name -like '*chatview*' }
  Assert "对话流区域存在" ($chat -and -not $chat.missing)
  Assert "渲染出 3 张候选卡片" ($rep.candCount -eq 3) "实际 $($rep.candCount)"
  Assert "双语块数 = 候选数×2（上客户语言/下中文）" ($rep.langBlocks -eq 6) "实际 $($rep.langBlocks)"
  Assert "上层标签写明发给客户" (($rep.langLabels | Where-Object { $_ -like '*发给客户*' }).Count -eq 3)
  Assert "下层标签为中文对照" (($rep.langLabels | Where-Object { $_ -eq '中文对照' }).Count -eq 3)

  Write-Host ""
  Write-Host "==============================================" -ForegroundColor Cyan
  if ($fail -eq 0) { Write-Host "  布局全部通过" -ForegroundColor Green }
  else { Write-Host ("  布局检查失败 $fail 项") -ForegroundColor Red }
  Write-Host "==============================================" -ForegroundColor Cyan
  exit $fail

} finally {
  if (-not $Keep) { Remove-Item $testJs   -Force -ErrorAction SilentlyContinue }
  if (-not $Keep) { Remove-Item $testHtml -Force -ErrorAction SilentlyContinue }
  if ($tempServer) { try { Stop-Process -Id $tempServer.Id -Force -ErrorAction SilentlyContinue } catch {} }
}
