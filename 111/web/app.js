/* =====================================================================
   111/web/app.js  ·  坐席工作台前端
   四种读取方式共用同一条处理管线：窗口直读 / 剪贴板 / 读屏OCR / 手动输入
   ===================================================================== */
'use strict';

const $  = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

const state = {
  mode: 'uia',
  lastResult: null,
  lastReadText: '',        // 防止同一段文字被反复分析
  busy: false,
  // OCR
  stream: null, capturing: false, timer: null, canvas: null, ctx: null, video: null,
  lastSig: null, lastPostAt: 0, ocrInfo: null,
  // UIA / 剪贴板
  uiaTimer: null, uiaWatching: false,
  clipTimer: null, clipWatching: false,
  winsLoaded: false
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
  t._h = setTimeout(() => t.classList.remove('on'), 2200);
}

function setReadStatus(html, cls) {
  const n = $('#readStatus');
  n.innerHTML = html || '';
  n.className = 'read-status' + (cls ? ' ' + cls : '');
}

/* ---------------- 启动 ---------------- */
async function health() {
  try {
    const r = await fetch('/api/health').then(x => x.json());
    if (!r.ok) return;
    const d = r.data || {};
    $('#kbBadge').textContent = `规则 ${d.compliance_rules} · 术语 ${d.glossary} · 政策 ${d.policy_index}`;
    window.__HEALTH = r;

    // 模型状态
    const m = r.model || { mode: 'local-fallback', provider: 'local' };
    const b = $('#modelBadge');
    if (m.mode === 'model') {
      b.textContent = `模型：${m.provider}${m.model ? ' / ' + m.model : ''}`;
      b.className = 'badge badge-model on';
    } else {
      b.textContent = '模型：本地规则引擎';
      b.className = 'badge badge-model';
      b.title = '未接入外部模型。配置方法见 111/README.md 与 config.example.json';
    }

    // 各读取方式可用性
    if (!r.ocr_languages || !r.ocr_languages.length) {
      $('#btnCapture').disabled = true;
      $('#btnCapture').title = '本机未安装 Windows OCR 语言包';
    }
    if (r.uia_available === false) {
      $('#btnUiaWatch').disabled = true;
      $('#btnUiaWatch').title = 'UI Automation 不可用';
    }
    if (r.clipboard_available === false) {
      $('#btnClipWatch').disabled = true;
    }
  } catch (e) {
    $('#kbBadge').textContent = '服务未连接';
    toast('无法连接本地服务', false);
  }
}

/* ---------------- 模式切换 ---------------- */
function stopAll() {
  stopCapture();
  stopUiaWatch();
  stopClipWatch();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  ['uia', 'clipboard', 'ocr', 'text'].forEach(m => {
    const p = document.getElementById('pane-' + m);
    if (p) p.classList.toggle('hidden', m !== mode);
  });
  stopAll();
  setReadStatus('');
  if (mode === 'uia') loadWindows();
}

/* ---------------- ① 窗口直读（UI Automation） ---------------- */
async function loadWindows() {
  const sel = $('#winSelect');
  try {
    const r = await fetch('/api/windows').then(x => x.json());
    if (!r.ok || !r.windows || !r.windows.length) {
      sel.innerHTML = '<option value="">未发现窗口</option>';
      return;
    }
    sel.innerHTML = '';
    r.windows.forEach(w => {
      const o = document.createElement('option');
      o.value = w.title;
      o.textContent = `${w.title.length > 42 ? w.title.slice(0, 42) + '…' : w.title}  [${w.process}]`;
      sel.appendChild(o);
    });
    state.winsLoaded = true;
    setReadStatus(`发现 ${r.windows.length} 个窗口，选一个再点开始`);
  } catch (e) {
    sel.innerHTML = '<option value="">获取窗口失败</option>';
  }
}

async function readUiaOnce(silent) {
  const title = $('#winSelect').value;
  if (!title) { if (!silent) toast('请先选择一个窗口', false); return null; }
  try {
    const r = await fetch('/api/uia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    }).then(x => x.json());
    if (!r.ok) { if (!silent) toast(r.error || '读取失败', false); return null; }
    return r.read;
  } catch (e) { if (!silent) toast('读取失败：' + e.message, false); return null; }
}

function startUiaWatch() {
  if (state.uiaWatching) return;
  const title = $('#winSelect').value;
  if (!title) { toast('请先选择一个窗口', false); return; }
  state.uiaWatching = true;
  state.lastReadText = $('#chatText').value.trim();
  $('#btnUiaWatch').textContent = '⏹ 停止自动读取';
  $('#btnUiaWatch').classList.remove('primary');
  $('#btnUiaWatch').classList.add('danger');
  const b = $('#btnUiaWatch'); b._prev = '▶ 开始自动读取';

  state.uiaTimer = setInterval(async () => {
    if (state.busy) return;
    const r = await readUiaOnce(true);
    if (!r) return;
    if (r.text && r.text !== state.lastReadText) {
      state.lastReadText = r.text;
      $('#chatText').value = r.text;
      setReadStatus(`已读取 <b>${r.line_count}</b> 行 / ${r.char_count} 字（范围：${r.scope === 'document' ? '正文区' : '整窗'}，耗时 ${r.ms}ms）`, 'ok');
      await analyzeText(true);
    }
  }, 2500);
  toast('已开始自动读取：' + title.slice(0, 24));
  setReadStatus('监听中…改动窗口内容会自动分析');
}

function stopUiaWatch() {
  if (!state.uiaWatching) return;
  state.uiaWatching = false;
  if (state.uiaTimer) { clearInterval(state.uiaTimer); state.uiaTimer = null; }
  const b = $('#btnUiaWatch');
  b.textContent = '▶ 开始自动读取';
  b.classList.add('primary');
  b.classList.remove('danger');
}

/* ---------------- ② 剪贴板监听 ---------------- */
function startClipWatch() {
  if (state.clipWatching) return;
  state.clipWatching = true;
  state.lastReadText = $('#chatText').value.trim();
  $('#btnClipWatch').textContent = '⏹ 停止监听';
  $('#btnClipWatch').classList.remove('primary');
  $('#btnClipWatch').classList.add('danger');

  state.clipTimer = setInterval(async () => {
    if (state.busy) return;
    try {
      const r = await fetch('/api/clipboard').then(x => x.json());
      if (!r.ok) return;
      const t = (r.text || '').trim();
      if (t && t.length >= 4 && t !== state.lastReadText) {
        state.lastReadText = t;
        $('#chatText').value = t;
        setReadStatus(`已从剪贴板读取 <b>${t.length}</b> 字`, 'ok');
        await analyzeText(true);
      }
    } catch (e) {}
  }, 1500);
  toast('已开始监听剪贴板：选中对话按 Ctrl+C 即可');
  setReadStatus('监听中…在任意软件里选中对话按 <b>Ctrl+C</b>');
}

function stopClipWatch() {
  if (!state.clipWatching) return;
  state.clipWatching = false;
  if (state.clipTimer) { clearInterval(state.clipTimer); state.clipTimer = null; }
  const b = $('#btnClipWatch');
  b.textContent = '▶ 开始监听剪贴板';
  b.classList.add('primary');
  b.classList.remove('danger');
}

/* ---------------- ③ 读屏 OCR ---------------- */
async function startCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
    state.stream = stream;
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    await v.play();
    state.video = v;

    const c = document.createElement('canvas');
    c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
    state.canvas = c;
    state.ctx = c.getContext('2d', { willReadFrequently: true });

    state.capturing = true; state.lastSig = null; state.lastPostAt = 0;
    state.lastReadText = $('#chatText').value.trim();
    const b = $('#btnCapture');
    b.textContent = '⏹ 停止读屏'; b.classList.remove('primary'); b.classList.add('danger');
    stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
    state.timer = setInterval(captureTick, 1200);
    toast('读屏已开始，请在弹窗中选择客服窗口');
    setReadStatus('读屏中…画面变化会自动分析');
  } catch (e) {
    toast('未授权屏幕捕获：' + e.message, false);
  }
}

function stopCapture() {
  if (!state.capturing) return;
  state.capturing = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  const b = $('#btnCapture');
  if (b) { b.textContent = '▶ 开始读屏'; b.classList.add('primary'); b.classList.remove('danger'); }
  const d = $('#preview .live-dot'); if (d) d.remove();
}

async function captureTick() {
  if (!state.capturing || state.busy) return;
  const v = state.video, c = state.canvas, ctx = state.ctx;
  if (!v || !c || !ctx || v.videoWidth === 0) return;
  if (c.width !== v.videoWidth) c.width = v.videoWidth;
  if (c.height !== v.videoHeight) c.height = v.videoHeight;
  ctx.drawImage(v, 0, 0, c.width, c.height);

  let sig = '';
  try {
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const step = 4 * 97;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += step) { sum = (sum + d[i]) % 1000000007; n++; }
    sig = sum + ':' + n;
  } catch (e) { sig = String(Date.now()); }

  if (sig === state.lastSig) return;
  const now = Date.now();
  if (now - state.lastPostAt < 2500) return;
  state.lastSig = sig; state.lastPostAt = now;

  const dataUrl = c.toDataURL('image/jpeg', 0.85);
  $('#preview').innerHTML = '<div class="live-dot"><i></i>LIVE 读屏中</div>';
  const img = new Image(); img.src = dataUrl;
  $('#preview').appendChild(img);
  await sendImage(dataUrl, true);
}

async function sendImage(dataUrl, silent) {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await fetch('/api/ocr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: dataUrl,
        country: $('#selCountry').value, platform: $('#selPlatform').value,
        category: $('#selCategory').value, ocrLanguage: $('#ocrLang').value
      })
    }).then(x => x.json());
    if (!r.ok) { if (!silent) toast(r.error || '识别失败', false); return; }
    if (r.ocr && r.ocr.text) {
      if (r.ocr.text !== state.lastReadText) {
        state.lastReadText = r.ocr.text;
        $('#chatText').value = r.ocr.text;
        state.ocrInfo = r.ocr;
        setReadStatus(`OCR 读取 <b>${r.ocr.char_count}</b> 字（语言 ${r.ocr.language_used}）`, 'ok');
        render(r.result);
      }
    }
  } catch (e) {
    if (!silent) toast('请求失败：' + e.message, false);
  } finally { state.busy = false; }
}

/* ---------------- 分析 ---------------- */
async function analyzeText(silent) {
  const text = $('#chatText').value.trim();
  if (!text) { if (!silent) toast('请先读取或输入对话内容', false); return; }
  if (silent === true && state.mode !== 'ocr') state.ocrInfo = null;
  const btn = $('#btnAnalyze');
  const prev = btn.innerHTML;
  if (!silent) { btn.innerHTML = '<span class="spin"></span> 分析中…'; btn.disabled = true; }
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, country: $('#selCountry').value,
        platform: $('#selPlatform').value, category: $('#selCategory').value
      })
    }).then(x => x.json());
    if (!r.ok) { if (!silent) toast(r.error || '分析失败', false); return; }
    render(r.result);
    if (!silent) toast('已生成候选话术');
  } catch (e) {
    if (!silent) toast('请求失败：' + e.message, false);
  } finally {
    if (!silent) { btn.innerHTML = prev; btn.disabled = false; }
  }
}

/* ---------------- 渲染：候选话术 ---------------- */
const LANG_LABEL = { en: 'English', es: 'Español', zh: '中文' };

function pickText(c, lang) {
  if (lang === 'zh') return { text: c.text_zh, note: '' };
  if (lang === 'es') {
    if (c.text_es) return { text: c.text_es, note: '' };
    return { text: c.text_en, note: '本演示未内置该风格的西语版本，暂以英文代替；接入千帆翻译 Agent 后可自动回译' };
  }
  return { text: c.text_en, note: '' };
}

/** 构造"上层=发给客户的语言 / 下层=中文对照"的双语块 */
function buildBilingualBlocks(c, target) {
  const picked = pickText(c, target);
  const blocks = [];

  // ── 上：发给客户的语言 ──
  const top = el('div', 'cand-lang');
  const topBar = el('div', 'lang-bar');
  topBar.appendChild(el('span', 'lang-name', '发给客户 · ' + (LANG_LABEL[target] || target)));
  const topCopy = el('button', 'btn xs ghost', '复制');
  topCopy.title = '只复制这一段（客户语言）';
  topCopy.onclick = () => copyText(picked.text || c.text_zh);
  topBar.appendChild(topCopy);
  top.appendChild(topBar);
  top.appendChild(el('div', 'lang-text', picked.text || c.text_zh));
  blocks.push(top);

  // ── 下：中文对照 ──
  if (target !== 'zh') {
    const bot = el('div', 'cand-lang zh');
    const botBar = el('div', 'lang-bar');
    botBar.appendChild(el('span', 'lang-name', '中文对照'));
    const botCopy = el('button', 'btn xs ghost', '复制');
    botCopy.title = '只复制这一段（中文）';
    botCopy.onclick = () => copyText(c.text_zh);
    botBar.appendChild(botCopy);
    bot.appendChild(botBar);
    bot.appendChild(el('div', 'lang-text', c.text_zh));
    blocks.push(bot);
  }

  if (picked.note) blocks.push(el('div', 'lang-note', 'ⓘ ' + picked.note));
  return blocks;
}

function renderCandidates(res) {
  const wrap = $('#candidates');
  wrap.innerHTML = '';
  const target = $('#selTarget').value;
  const compMap = {};
  (res.compliance || []).forEach(c => compMap[c.candidate_id] = c);
  const recId = res.final ? res.final.recommended_candidate_id : '';
  $('#candMeta').textContent = `共 ${res.candidates.length} 条 · 推荐 ${recId || '无'}`;

  if (!res.candidates.length) { wrap.appendChild(el('div', 'empty-state', '没有生成候选话术')); return; }

  res.candidates.forEach(c => {
    const comp = compMap[c.candidate_id] || { decision: 'pass', violations: [] };
    const isRec = (c.candidate_id === recId);
    const picked = pickText(c, target);   // 底部按钮也要用，这里先取一次
    const card = el('div', 'cand' + (isRec ? ' recommended' : '') + (comp.decision === 'reject' ? ' rejected' : ''));

    const head = el('div', 'cand-head');
    head.appendChild(el('span', 'tag style', esc(c.style)));
    if (isRec) head.appendChild(el('span', 'tag rec', '★ 推荐'));
    head.appendChild(el('span', 'tag ' + comp.decision,
      comp.decision === 'pass' ? '✓ 合规通过' : comp.decision === 'revise' ? '⚠ 需修订' : '✕ 已拦截'));
    if (c.unsupported) head.appendChild(el('span', 'tag unsupported', '无知识依据'));
    card.appendChild(head);

    // 双语：上=客户语言，下=中文对照（上下分割）
    buildBilingualBlocks(c, target).forEach(b => card.appendChild(b));

    (comp.violations || []).forEach(v => {
      const box = el('div', 'violation' + (v.severity === 'revise' ? ' revise' : ''));
      box.innerHTML = `<b>[${esc(v.rule_id)}]</b> ${esc(v.title || '')}<br>` +
        `命中片段：<span class="vspan">${esc(v.span)}</span><br>` +
        `原因：${esc(v.reason)}<br>建议：${esc(v.suggestion)}`;
      card.appendChild(box);
    });

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
    trace_id: res.trace_id, action, style: cand.style, candidate_id: cand.candidate_id,
    intent: res.analysis.primary_intent, country: res.input.country,
    final_text: finalText != null ? finalText : (cand.text_zh || '')
  };
  try { await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
  toast('已记录：' + (ACTION_ZH[action] || action));
}

/* ---------------- 渲染：分析面板 ---------------- */
function kv(k, v) {
  const d = el('div', 'kv');
  d.innerHTML = `<span>${esc(k)}</span><span>${v}</span>`;
  return d;
}

function renderAnalysis(res) {
  const box = $('#analysis');
  box.innerHTML = '';
  const a = res.analysis, esc_ = res.escalation;

  if (esc_.need_human) {
    const al = el('div', 'alert human');
    al.innerHTML = `<b>⚠ 建议转人工</b>（${esc(ESC_ZH[esc_.reason] || esc_.reason || '')}）<br>` +
      `系统不会替你发送话术。请先核对下方政策依据，再决定如何回复。`;
    box.appendChild(al);
  } else {
    box.appendChild(el('div', 'alert ok', '<b>✓ 可直接使用</b><br>候选话术已通过合规校验，可复制发送。'));
  }

  const sInput = el('div', 'an-sec');
  sInput.appendChild(el('div', 'an-title', '输入'));
  const srcMap = { screenshot: '读屏 OCR', text: '文本输入', uia: '窗口直读', clipboard: '剪贴板' };
  sInput.appendChild(kv('来源', srcMap[res.input.source] || res.input.source));
  sInput.appendChild(kv('识别语言', res.input.detected_lang.toUpperCase()));
  if (state.ocrInfo) sInput.appendChild(kv('OCR 语言', state.ocrInfo.language_used + '（' + state.ocrInfo.char_count + ' 字）'));
  sInput.appendChild(kv('客户国家', (COUNTRY_ZH[res.input.country] || res.input.country)));
  sInput.appendChild(kv('渠道', res.input.platform));
  box.appendChild(sInput);

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
  if ((a.emotion.signals || []).length) s1.appendChild(kv('情绪信号', esc(a.emotion.signals.join(' · '))));
  const m = el('div', 'meter');
  m.innerHTML = `<i style="width:${a.emotion.intensity * 20}%;background:${urgColor}"></i>`;
  s1.appendChild(m);
  box.appendChild(s1);

  if ((a.risk_flags || []).length) {
    const s2 = el('div', 'an-sec');
    s2.appendChild(el('div', 'an-title', '风险标记'));
    const p = el('div');
    a.risk_flags.forEach(r => p.appendChild(el('span', 'pill risk', esc(RISK_ZH[r] || r))));
    s2.appendChild(p);
    box.appendChild(s2);
  }

  const s3 = el('div', 'an-sec');
  s3.appendChild(el('div', 'an-title', '话术风格'));
  const p3 = el('div');
  p3.appendChild(el('span', 'pill style', '主推：' + esc(a.suggested_style)));
  (res.candidates || []).forEach(c => p3.appendChild(el('span', 'pill style', esc(c.style))));
  s3.appendChild(p3);
  box.appendChild(s3);

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

  const s5 = el('div', 'an-sec');
  s5.appendChild(el('div', 'an-title', `知识检索 · 覆盖度 ${res.retrieval.coverage}`));
  s5.appendChild(kv('检索库', (res.retrieval.kb_route || []).join(' / ')));
  s5.appendChild(kv('查询条数', String((res.retrieval.queries || []).length)));
  const covColor = { sufficient:'var(--ok)', partial:'var(--warn)', insufficient:'var(--bad)' }[res.retrieval.coverage];
  s5.appendChild(kv('覆盖度', `<span style="color:${covColor};font-weight:700">${res.retrieval.coverage}</span>`));
  box.appendChild(s5);

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

  const s8 = el('div', 'an-sec');
  s8.appendChild(el('div', 'an-title', '链路'));
  s8.appendChild(kv('trace_id', esc(res.trace_id)));
  s8.appendChild(kv('耗时', res.meta.latency_ms + ' ms'));
  s8.appendChild(kv('模式', esc(res.meta.mode)));
  if (res.meta.generated_by) s8.appendChild(kv('话术来源', esc(res.meta.generated_by === 'model' ? '模型生成' : '本地模板')));
  if ((res.meta.model_used || []).length) s8.appendChild(kv('模型环节', esc(res.meta.model_used.join('、'))));
  if ((res.meta.degraded_nodes || []).length) s8.appendChild(kv('降级节点', esc(res.meta.degraded_nodes.join(', '))));
  box.appendChild(s8);
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

document.querySelectorAll('#tabs .tab').forEach(t => {
  t.onclick = () => setMode(t.dataset.mode);
});
$('#btnRefreshWins').onclick = loadWindows;
$('#btnUiaWatch').onclick = () => state.uiaWatching ? stopUiaWatch() : startUiaWatch();
$('#btnClipWatch').onclick = () => state.clipWatching ? stopClipWatch() : startClipWatch();
$('#btnCapture').onclick = () => state.capturing ? stopCapture() : startCapture();
$('#btnAnalyze').onclick = () => analyzeText(false);
$('#btnClear').onclick = () => { $('#chatText').value = ''; state.lastReadText = ''; setReadStatus(''); };
$('#btnDemo').onclick = () => {
  $('#chatText').value = DEMO;
  state.lastReadText = DEMO;
  $('#selCountry').value = 'ES';
  $('#selPlatform').value = 'tiktok_shop';
  $('#selCategory').value = 'dress';
  toast('已填充演示样本（西班牙 · TikTok Shop · 连衣裙）');
};
$('#btnStats').onclick = showStats;
$('#modalClose').onclick = () => $('#modal').classList.remove('on');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); };
$('#selTarget').onchange = () => { if (state.lastResult) renderCandidates(state.lastResult); };

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
setMode('uia');
