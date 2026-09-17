/* =====================================================================
   111/web/app.js  ·  坐席工作台前端
   三种输入方式共用同一条处理管线：自动读屏 / 粘贴截图 / 直接输入文本
   ===================================================================== */
'use strict';

const $  = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

const state = {
  lastResult: null,
  stream: null,
  capturing: false,
  timer: null,
  canvas: null,
  ctx: null,
  video: null,
  lastSig: null,
  lastPostAt: 0,
  busy: false
};

const COUNTRY_ZH = { UNKNOWN:'未知', ES:'西班牙', DE:'德国', FR:'法国', IT:'意大利', US:'美国', GB:'英国', NL:'荷兰', EU:'欧盟' };
const INTENT_ZH  = { refund:'退款诉求', exchange:'换货诉求', logistics:'物流催件与丢件', quality_defect:'质量投诉',
  color_diff:'色差', sizing:'尺码问题', negative_review:'差评维权', repurchase:'复购咨询', product_info:'产品咨询',
  payment:'支付问题', customs:'关税与清关', invoice:'发票需求', complaint_service:'服务态度投诉', other:'其他' };
const RISK_ZH = { chargeback_risk:'拒付风险', platform_intervention_risk:'平台介入风险', legal_risk:'法律风险',
  public_opinion_risk:'舆情风险', repeat_complaint:'重复投诉', minor_involved:'涉未成年人' };
const ESC_ZH = { critical_urgency:'紧急度极高', escalated_emotion:'情绪失控', high_value_dispute:'高价值纠纷',
  insufficient_knowledge:'知识库无依据', all_candidates_rejected:'全部候选被合规拦截',
  platform_risk:'平台/拒付风险', legal_risk:'法律风险', customer_request:'客户要求转人工',
  low_acceptance:'连续未采纳', degraded_pipeline:'链路降级' };
const ACTION_ZH = { accept:'采纳', edit:'修改后采纳', ignore:'忽略' };

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = ok ? 'var(--ok)' : 'var(--bad)';
  t.style.color = ok ? '#04210f' : '#fff';
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 1900);
}

/* ---------------- 启动：健康检查 ---------------- */
async function health() {
  try {
    const r = await fetch('/api/health').then(x => x.json());
    if (r.ok) {
      const d = r.data || {};
      $('#kbBadge').textContent = `规则 ${d.compliance_rules} · 术语 ${d.glossary} · 政策 ${d.policy_index}`;
      window.__HEALTH = r;
      if (!r.ocr_languages || !r.ocr_languages.length) {
        $('#ocrLang').innerHTML = '<option value="">本机无 OCR 语言包</option>';
        $('#btnCapture').disabled = true;
        $('#btnCapture').title = '本机未安装 Windows OCR 语言包，请用粘贴文本方式';
      }
    }
  } catch (e) {
    $('#kbBadge').textContent = '服务未连接';
    toast('无法连接本地服务', false);
  }
}

/* ---------------- 自动读屏 ---------------- */
async function startCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 2 },
      audio: false
    });
    state.stream = stream;
    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    state.video = v;

    const c = document.createElement('canvas');
    c.width = v.videoWidth || 1280;
    c.height = v.videoHeight || 720;
    state.canvas = c;
    state.ctx = c.getContext('2d', { willReadFrequently: true });

    state.capturing = true;
    state.lastSig = null;
    state.lastPostAt = 0;
    $('#btnCapture').textContent = '⏹ 停止读屏';
    $('#btnCapture').classList.remove('primary');
    $('#btnCapture').classList.add('danger');

    stream.getVideoTracks()[0].addEventListener('ended', stopCapture);

    // 每 1.2 秒抓一帧，画面有明显变化才送去识别
    state.timer = setInterval(captureTick, 1200);
    toast('读屏已开始，请在弹窗中选择客服窗口');
  } catch (e) {
    toast('未授权屏幕捕获：' + e.message, false);
  }
}

function stopCapture() {
  state.capturing = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  const b = $('#btnCapture');
  b.textContent = '▶ 开始自动读屏';
  b.classList.add('primary');
  b.classList.remove('danger');
  const d = $('#preview .live-dot'); if (d) d.remove();
}

/* 抓帧 → 变化检测 → OCR */
async function captureTick() {
  if (!state.capturing || state.busy) return;
  const v = state.video, c = state.canvas, ctx = state.ctx;
  if (!v || !c || !ctx || v.videoWidth === 0) return;

  if (c.width !== v.videoWidth)  c.width = v.videoWidth;
  if (c.height !== v.videoHeight) c.height = v.videoHeight;
  ctx.drawImage(v, 0, 0, c.width, c.height);

  // 计算画面签名（抽样像素），判断是否有实质变化
  let sig = '';
  try {
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const step = 4 * 97; // 抽样
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += step) { sum = (sum + d[i]) % 1000000007; n++; }
    sig = sum + ':' + n;
  } catch (e) { sig = String(Date.now()); }

  if (sig === state.lastSig) return;                        // 画面没变，跳过
  const now = Date.now();
  if (now - state.lastPostAt < 2500) return;                 // 节流
  state.lastSig = sig;
  state.lastPostAt = now;

  // 更新预览
  const dataUrl = c.toDataURL('image/jpeg', 0.85);
  $('#preview').innerHTML = '<div class="live-dot"><i></i>LIVE 读屏中</div>';
  const img = new Image(); img.src = dataUrl;
  $('#preview').appendChild(img);

  await sendImage(dataUrl, true);
}

/* ---------------- 图片 → OCR → 分析 ---------------- */
async function sendImage(dataUrl, silent) {
  if (state.busy) return;
  state.busy = true;
  const prev = $('#btnAnalyze').innerHTML;
  if (!silent) { $('#btnAnalyze').innerHTML = '<span class="spin"></span> 识别中…'; $('#btnAnalyze').disabled = true; }
  try {
    const r = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: dataUrl,
        country: $('#selCountry').value,
        platform: $('#selPlatform').value,
        category: $('#selCategory').value,
        ocrLanguage: $('#ocrLang').value
      })
    }).then(x => x.json());

    if (!r.ok) {
      if (!silent) toast(r.error || '识别失败', false);
      return;
    }
    if (r.ocr && r.ocr.text) $('#chatText').value = r.ocr.text;
    state.ocrInfo = r.ocr;
    render(r.result);
    if (!silent) toast('识别完成：' + (r.ocr ? r.ocr.char_count : 0) + ' 字');
  } catch (e) {
    if (!silent) toast('请求失败：' + e.message, false);
  } finally {
    state.busy = false;
    if (!silent) { $('#btnAnalyze').innerHTML = prev; $('#btnAnalyze').disabled = false; }
  }
}

/* ---------------- 文本 → 分析 ---------------- */
async function analyzeText() {
  const text = $('#chatText').value.trim();
  if (!text) { toast('请先输入或识别对话内容', false); return; }
  state.ocrInfo = null;
  const btn = $('#btnAnalyze');
  const prev = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> 分析中…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        country: $('#selCountry').value,
        platform: $('#selPlatform').value,
        category: $('#selCategory').value
      })
    }).then(x => x.json());
    if (!r.ok) { toast(r.error || '分析失败', false); return; }
    render(r.result);
    toast('已生成候选话术');
  } catch (e) {
    toast('请求失败：' + e.message, false);
  } finally {
    btn.innerHTML = prev;
    btn.disabled = false;
  }
}

/* ---------------- 渲染：候选话术 ---------------- */
function pickText(c, lang) {
  if (lang === 'zh') return { text: c.text_zh, note: '' };
  if (lang === 'es') {
    if (c.text_es) return { text: c.text_es, note: '' };
    return { text: c.text_en, note: '本演示未内置该风格的西语版本，已回退为英文；接入千帆翻译 Agent 后可自动回译' };
  }
  return { text: c.text_en, note: '' };
}

function renderCandidates(res) {
  const wrap = $('#candidates');
  wrap.innerHTML = '';
  const target = $('#selTarget').value;
  const compMap = {};
  (res.compliance || []).forEach(c => compMap[c.candidate_id] = c);

  const recId = res.final ? res.final.recommended_candidate_id : '';
  $('#candMeta').textContent = `共 ${res.candidates.length} 条 · 推荐 ${recId || '无'}`;

  if (!res.candidates.length) {
    wrap.appendChild(el('div', 'empty-state', '没有生成候选话术'));
    return;
  }

  res.candidates.forEach(c => {
    const comp = compMap[c.candidate_id] || { decision: 'pass', violations: [] };
    const isRec = (c.candidate_id === recId);
    const card = el('div', 'cand' + (isRec ? ' recommended' : '') + (comp.decision === 'reject' ? ' rejected' : ''));

    // 头部
    const head = el('div', 'cand-head');
    head.appendChild(el('span', 'tag style', esc(c.style)));
    if (isRec) head.appendChild(el('span', 'tag rec', '★ 推荐'));
    head.appendChild(el('span', 'tag ' + comp.decision,
      comp.decision === 'pass' ? '✓ 合规通过' : comp.decision === 'revise' ? '⚠ 需修订' : '✕ 已拦截'));
    if (c.unsupported) head.appendChild(el('span', 'tag unsupported', '无知识依据'));
    card.appendChild(head);

    // 正文
    const body = el('div', 'cand-body');
    const picked = pickText(c, target);
    body.textContent = picked.text || c.text_zh;
    card.appendChild(body);

    if (target !== 'zh') {
      const zhBox = el('div', 'cand-body target');
      zhBox.textContent = '中文：' + c.text_zh;
      card.appendChild(zhBox);
    }
    if (picked.note) {
      const n = el('div', 'cand-body target');
      n.style.color = 'var(--warn)';
      n.textContent = 'ⓘ ' + picked.note;
      card.appendChild(n);
    }

    // 违规明细
    (comp.violations || []).forEach(v => {
      const box = el('div', 'violation' + (v.severity === 'revise' ? ' revise' : ''));
      box.innerHTML = `<b>[${esc(v.rule_id)}]</b> ${esc(v.title || '')}<br>` +
        `命中片段：<span class="vspan">${esc(v.span)}</span><br>` +
        `原因：${esc(v.reason)}<br>建议：${esc(v.suggestion)}`;
      card.appendChild(box);
    });

    // 底部操作
    const foot = el('div', 'cand-foot');
    if (comp.decision !== 'reject') {
      const bCopy = el('button', 'btn sm ' + (isRec ? 'rec' : ''), '📋 复制话术');
      bCopy.onclick = () => copyText(picked.text || c.text_zh);
      foot.appendChild(bCopy);

      const bAcc = el('button', 'btn sm', '✓ 采纳');
      bAcc.onclick = () => feedback('accept', c, res);
      foot.appendChild(bAcc);

      const bEdit = el('button', 'btn sm', '✎ 修改后采纳');
      bEdit.onclick = () => {
        const v = prompt('修改后发送的内容：', picked.text || c.text_zh);
        if (v != null) { copyText(v); feedback('edit', c, res, v); }
      };
      foot.appendChild(bEdit);
    } else {
      foot.appendChild(el('span', 'tag reject', '该话术违反合规规则，不可发送'));
    }

    const bIgn = el('button', 'btn sm ghost', '✕ 忽略');
    bIgn.onclick = () => feedback('ignore', c, res);
    foot.appendChild(bIgn);

    foot.appendChild(el('span', 'cand-meta', '依据 ' + ((c.cited_evidence || []).join(', ') || '无')));
    card.appendChild(foot);

    wrap.appendChild(card);
  });
}

function copyText(t) {
  navigator.clipboard.writeText(t).then(
    () => toast('已复制，可直接粘贴到对话窗口'),
    () => { const ta = el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制'); }
  );
}

async function feedback(action, cand, res, finalText) {
  const payload = {
    trace_id: res.trace_id, action: action, style: cand.style, candidate_id: cand.candidate_id,
    intent: res.analysis.primary_intent, country: res.input.country,
    final_text: finalText != null ? finalText : (cand.text_zh || '')
  };
  try { await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
  toast('已记录：' + (ACTION_ZH[action] || action));
}

/* ---------------- 渲染：分析面板 ---------------- */
function renderAnalysis(res) {
  const box = $('#analysis');
  box.innerHTML = '';
  const a = res.analysis, esc_ = res.escalation;

  // 转人工提示
  if (esc_.need_human) {
    const al = el('div', 'alert human');
    al.innerHTML = `<b>⚠ 建议转人工</b>（${esc(ESC_ZH[esc_.reason] || esc_.reason || '')}）<br>` +
      `系统不会替你发送话术。请先核对下方政策依据，再决定如何回复。`;
    box.appendChild(al);
  } else {
    box.appendChild(el('div', 'alert ok', '<b>✓ 可直接使用</b><br>候选话术已通过合规校验，可复制发送。'));
  }

  // 输入
  const sInput = el('div', 'an-sec');
  sInput.appendChild(el('div', 'an-title', '输入'));
  sInput.appendChild(kv('来源', res.input.source === 'screenshot' ? '自动读屏 / 截图' : '文本输入'));
  sInput.appendChild(kv('识别语言', res.input.detected_lang.toUpperCase()));
  if (state.ocrInfo) {
    sInput.appendChild(kv('OCR 语言', state.ocrInfo.language_used + '（' + state.ocrInfo.char_count + ' 字）'));
  }
  sInput.appendChild(kv('客户国家', (COUNTRY_ZH[res.input.country] || res.input.country)));
  sInput.appendChild(kv('渠道', res.input.platform));
  box.appendChild(sInput);

  // 意图情绪
  const s1 = el('div', 'an-sec');
  s1.appendChild(el('div', 'an-title', '意图 / 情绪 / 紧急度'));
  const pIntents = el('div');
  (a.intents || []).forEach(i => pIntents.appendChild(el('span', 'pill intent',
    `${esc(i.label_zh || INTENT_ZH[i.label] || i.label)} ${(i.confidence * 100).toFixed(0)}%`)));
  s1.appendChild(pIntents);

  s1.appendChild(kv('主意图', esc(a.primary_intent_zh || INTENT_ZH[a.primary_intent] || a.primary_intent)));
  s1.appendChild(kv('情绪', `${a.emotion.polarity} / 强度 ${a.emotion.intensity}`));
  const urgColor = { low:'var(--ok)', medium:'var(--acc)', high:'var(--warn)', critical:'var(--bad)' }[a.urgency];
  s1.appendChild(kv('紧急度', `<span style="color:${urgColor}">${a.urgency}</span>`));
  if ((a.emotion.signals || []).length) {
    s1.appendChild(kv('情绪信号', esc(a.emotion.signals.join(' · '))));
  }
  const m = el('div', 'meter');
  m.innerHTML = `<i style="width:${a.emotion.intensity * 20}%;background:${urgColor}"></i>`;
  s1.appendChild(m);
  box.appendChild(s1);

  // 风险
  if ((a.risk_flags || []).length) {
    const s2 = el('div', 'an-sec');
    s2.appendChild(el('div', 'an-title', '风险标记'));
    const p = el('div');
    a.risk_flags.forEach(r => p.appendChild(el('span', 'pill risk', esc(RISK_ZH[r] || r))));
    s2.appendChild(p);
    box.appendChild(s2);
  }

  // 话术风格
  const s3 = el('div', 'an-sec');
  s3.appendChild(el('div', 'an-title', '话术风格'));
  const p3 = el('div');
  p3.appendChild(el('span', 'pill style', '主推：' + esc(a.suggested_style)));
  (res.candidates || []).forEach(c => p3.appendChild(el('span', 'pill style', esc(c.style))));
  s3.appendChild(p3);
  box.appendChild(s3);

  // 术语命中
  const gh = (res.translation && res.translation.glossary_hits) || [];
  if (gh.length) {
    const s4 = el('div', 'an-sec');
    s4.appendChild(el('div', 'an-title', `术语命中（${gh.length}）`));
    const p4 = el('div');
    gh.slice(0, 8).forEach(h => {
      const label = h.term_zh ? `${h.foreign || h.source_term} → ${h.term_zh}` : `${h.source_term} → ${h.target_term}`;
      p4.appendChild(el('span', 'pill term', esc(label)));
    });
    s4.appendChild(p4);
    box.appendChild(s4);
  }

  // 检索
  const s5 = el('div', 'an-sec');
  s5.appendChild(el('div', 'an-title', `知识检索 · 覆盖度 ${res.retrieval.coverage}`));
  s5.appendChild(kv('检索库', (res.retrieval.kb_route || []).join(' / ')));
  s5.appendChild(kv('查询条数', String((res.retrieval.queries || []).length)));
  const covColor = { sufficient:'var(--ok)', partial:'var(--warn)', insufficient:'var(--bad)' }[res.retrieval.coverage];
  s5.appendChild(kv('覆盖度', `<span style="color:${covColor};font-weight:700">${res.retrieval.coverage}</span>`));
  box.appendChild(s5);

  // 证据
  const s6 = el('div', 'an-sec');
  s6.appendChild(el('div', 'an-title', `政策依据（${(res.retrieval.evidence || []).length}）`));
  if (!(res.retrieval.evidence || []).length) {
    s6.appendChild(el('div', 'hint', '⚠ 未检索到可依据的政策条目 —— 此时系统不会给出任何政策承诺。'));
  }
  (res.retrieval.evidence || []).forEach(e => {
    const d = el('div', 'ev');
    d.innerHTML = `<div class="ev-title">${esc(e.title)}</div>` +
      `<div style="color:var(--tx2)">${esc(e.snippet)}</div>` +
      `<div class="ev-meta"><span>${esc(e.doc_id)}</span><span>${esc(e.country)}</span>` +
      `<span>生效 ${esc(e.effective_date)}</span><span>匹配度 ${e.score}</span></div>`;
    s6.appendChild(d);
  });
  box.appendChild(s6);

  // 交接包
  if (esc_.need_human && esc_.handoff_packet) {
    const hp = esc_.handoff_packet;
    const s7 = el('div', 'an-sec');
    s7.appendChild(el('div', 'an-title', '转人工交接包'));
    s7.appendChild(kv('问题摘要', esc(hp.analysis_summary || '')));
    s7.appendChild(kv('建议动作', esc(hp.suggested_next_step || '')));
    if ((hp.rejected_candidates || []).length) {
      const rj = el('div', 'hint');
      rj.innerHTML = '<b>已拦截的话术（请勿发送）：</b><br>' +
        hp.rejected_candidates.map(r => `· [${esc(r.rule_id)}] ${esc(r.reason)}`).join('<br>');
      s7.appendChild(rj);
    }
    box.appendChild(s7);
  }

  // 链路信息
  const s8 = el('div', 'an-sec');
  s8.appendChild(el('div', 'an-title', '链路'));
  s8.appendChild(kv('trace_id', esc(res.trace_id)));
  s8.appendChild(kv('耗时', res.meta.latency_ms + ' ms'));
  s8.appendChild(kv('模式', esc(res.meta.mode)));
  if ((res.meta.degraded_nodes || []).length) {
    s8.appendChild(kv('降级节点', esc(res.meta.degraded_nodes.join(', '))));
  }
  box.appendChild(s8);
}

function kv(k, v) {
  const d = el('div', 'kv');
  d.innerHTML = `<span>${esc(k)}</span><span>${v}</span>`;
  return d;
}

function render(res) {
  state.lastResult = res;
  renderCandidates(res);
  renderAnalysis(res);
}

/* ---------------- 数据闭环弹窗 ---------------- */
async function showStats() {
  try {
    const r = await fetch('/api/stats').then(x => x.json());
    const body = $('#modalBody');
    if (!r.total) {
      body.innerHTML = '<div class="hint">还没有记录。采纳 / 修改 / 忽略 任一操作后，这里会出现统计 —— 这就是「数据闭环 Agent」的输入。</div>';
    } else {
      const rows = Object.keys(r.by_action).map(k => `<div class="kv"><span>${esc(ACTION_ZH[k] || k)}</span><span>${r.by_action[k]}</span></div>`).join('');
      const styles = Object.keys(r.by_style).map(k => `<div class="kv"><span>${esc(k)}</span><span>${r.by_style[k]}</span></div>`).join('');
      body.innerHTML =
        `<div class="an-title">总体</div>` +
        `<div class="kv"><span>总推荐次数</span><span>${r.total}</span></div>` +
        `<div class="kv"><span>采纳率</span><span style="color:var(--ok)">${(r.accept_rate * 100).toFixed(1)}%</span></div>` +
        `<div class="an-title" style="margin-top:16px">按操作</div>${rows}` +
        `<div class="an-title" style="margin-top:16px">按风格</div>${styles || '<div class="hint">暂无</div>'}`;
    }
    $('#modalTitle').textContent = '数据闭环 · 采纳统计';
    $('#modal').classList.add('on');
  } catch (e) { toast('读取失败', false); }
}

/* ---------------- 事件绑定 ---------------- */
const DEMO = `Buyer: The dress arrived with stains and I want my money back
Buyer: I have been waiting 10 days already
Seller: So sorry, let me check your order
Buyer: If you don't handle this I will complain to the platform`;

$('#btnCapture').onclick = () => state.capturing ? stopCapture() : startCapture();
$('#btnAnalyze').onclick = analyzeText;
$('#btnDemo').onclick = () => {
  $('#chatText').value = DEMO;
  $('#selCountry').value = 'ES';
  $('#selPlatform').value = 'tiktok_shop';
  $('#selCategory').value = 'dress';
  toast('已填充演示样本（西班牙 · TikTok Shop · 连衣裙）');
};
$('#btnStats').onclick = showStats;
$('#modalClose').onclick = () => $('#modal').classList.remove('on');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); };
$('#selTarget').onchange = () => { if (state.lastResult) renderCandidates(state.lastResult); };

// Ctrl+V 粘贴截图
document.addEventListener('paste', (e) => {
  const items = (e.clipboardData || {}).items || [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image') === 0) {
      const f = it.getAsFile();
      const fr = new FileReader();
      fr.onload = () => {
        $('#preview').innerHTML = '';
        const img = new Image(); img.src = fr.result;
        $('#preview').appendChild(img);
        sendImage(fr.result, false);
      };
      fr.readAsDataURL(f);
      e.preventDefault();
      return;
    }
  }
});

// 拖拽图片
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f || f.type.indexOf('image') !== 0) return;
  const fr = new FileReader();
  fr.onload = () => {
    $('#preview').innerHTML = '';
    const img = new Image(); img.src = fr.result;
    $('#preview').appendChild(img);
    sendImage(fr.result, false);
  };
  fr.readAsDataURL(f);
});

health();
