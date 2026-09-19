/* =====================================================================
   hzj-ai-aftersales/web/app.js  ·  坐席工作台前端
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
/* ⚠️ 定位修正：本工具不是"AI 客服"，而是**已经转到人工之后，人工用的话术副驾**。
   所以这些不再是"要不要转人工"的理由，而是"人工回复前要小心的风险点"。 */
const ESC_ZH = { critical_urgency:'紧急度极高', escalated_emotion:'情绪失控', high_value_dispute:'高价值纠纷',
  insufficient_knowledge:'知识库无依据', all_candidates_rejected:'全部候选被合规拦截',
  platform_risk:'平台/拒付风险', legal_risk:'法律风险', customer_request:'客户要求主管介入', supervisor_required:'技能策略要求主管介入',
  low_acceptance:'连续未采纳', degraded_pipeline:'链路降级' };
const ACTION_ZH = { accept:'采纳', edit:'修改后采纳', ignore:'忽略' };

/* 说话人识别：客户转人工前的对话里，可能混着**别的 AI 客服**说过的话。
   人工回复前必须能分清，否则容易和 AI 之前说过的话自相矛盾。 */
const SPEAKER_PATTERNS = [
  { who:'buyer', re:/^\s*(buyer|buyers?|customer|client|买家|客户|顾客)\s*[:：]/i,  tag:'客户' },
  { who:'bot',   re:/^\s*(ai|bot|robot|chatbot|智能客服|机器人|自动回复|AI客服)\s*[:：]/i, tag:'AI客服' },
  { who:'human', re:/^\s*(seller|agent|me|support|客服|卖家|坐席|人工|我)\s*[:：]/i, tag:'人工客服' }
];
const WHO_LABEL = { buyer:'客户', bot:'AI客服', human:'人工客服', unknown:'未标注' };

/* 运行日志（黑框） */
const LOG = { items: [], filter:'all', max:320 };

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = ok ? 'var(--ok)' : 'var(--bad)';
  t.style.color = ok ? '#04210f' : '#fff';
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------------- 页面路由 ---------------- */
const PAGE_TITLE = { workbench:'工作台', tasks:'任务看板', skills:'技能中心', kb:'知识库', audit:'审计日志', settings:'设置' };
let currentPage = 'workbench';

function setPage(name) {
  currentPage = name;
  document.querySelectorAll('#sideNav .nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.page === name);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === 'page-' + name);
  });
  const t = $('#pageTitle');
  if (t) t.textContent = PAGE_TITLE[name] || name;
  if (name === 'skills') renderSkills();
  if (name === 'kb') renderKB();
  if (name === 'audit') renderAudit();
  if (name === 'settings') renderSettings();
}

/* ---------------- 运行日志 ---------------- */
function pushLog(node, status, msg, ms, kind) {
  LOG.items.push({
    t: new Date().toLocaleTimeString('zh-CN', { hour12:false }),
    node: node, status: status, msg: msg, ms: ms, kind: kind || 'agent'
  });
  if (LOG.items.length > LOG.max) LOG.items.splice(0, LOG.items.length - LOG.max);
  renderLog();
}

function renderLog() {
  const box = $('#logBody');
  if (!box) return;
  const list = LOG.items.filter(i => LOG.filter === 'all' || i.kind === LOG.filter);
  const cnt = $('#logCount');
  if (cnt) cnt.textContent = list.length + ' 条' + (LOG.filter === 'all' ? '' : '（已筛选）');

  if (!list.length) {
    box.innerHTML = '<div class="logempty">还没有执行记录。生成话术时，这里会显示每个 Agent 的执行结果、检索命中和合规拦截。</div>';
    return;
  }
  box.innerHTML = '';
  list.slice().reverse().forEach(i => {
    const line = el('div', 'logline ' + (i.status === 'ok' ? 'ok' : i.status === 'err' ? 'err' : i.status === 'warn' ? 'warn' : ''));
    line.appendChild(el('span', 'lt', esc(i.t)));
    line.appendChild(el('span', 'lnode', esc(i.node)));
    line.appendChild(el('span', 'lmsg', i.msg));            // 允许带 HTML（已在上游转义）
    if (i.ms != null) line.appendChild(el('span', 'lms', i.ms + 'ms'));
    box.appendChild(line);
  });
}

function clearLog() {
  LOG.items = [];
  renderLog();
}

/* ---------------- 对话解析与渲染 ---------------- */
function parseChat(raw) {
  const out = [];
  const lines = String(raw || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let matched = false;
    for (const p of SPEAKER_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        out.push({ who: p.who, tag: p.tag, text: line.slice(m[0].length).trim() });
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 没标说话人：接着上一条
      if (out.length) out[out.length - 1].text += '\n' + line.trim();
      else out.push({ who:'unknown', tag:'未标注', text: line.trim() });
    }
  }
  return out;
}

function renderChat() {
  const box = $('#chatView');
  if (!box) return;
  const msgs = parseChat($('#chatText').value);
  const stat = $('#turnStat');

  if (!msgs.length) {
    box.innerHTML = '<div class="chatempty">读取到的对话会在这里按「客户 / AI客服 / 人工客服」分类显示</div>';
    if (stat) stat.textContent = '';
    return;
  }
  const nBuyer = msgs.filter(m => m.who === 'buyer').length;
  const nBot   = msgs.filter(m => m.who === 'bot').length;
  const nHuman = msgs.filter(m => m.who === 'human').length;
  if (stat) stat.textContent = `共 ${msgs.length} 条 · 客户${nBuyer} / AI${nBot} / 人工${nHuman}`;

  box.innerHTML = '';
  msgs.forEach(m => {
    const b = el('div', 'bubble ' + m.who);
    const who = el('div', 'who');
    who.appendChild(el('span', 'wtag', m.tag));
    b.appendChild(who);
    b.appendChild(el('div', 'txt', esc(m.text)));
    box.appendChild(b);
  });
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 技能中心 / 知识库 / 设置 ---------------- */
async function renderSkills() {
  const box = $('#skillGrid');
  if (!box) return;
  box.innerHTML = '<div class="hint">正在加载技能…</div>';
  let data = null;
  try { data = await fetch('/api/skills').then(r => r.json()); } catch (e) {}
  if (!data || !data.ok || !data.skills) {
    box.innerHTML = '<div class="hint">读不到技能列表（本地服务未启动？）</div>';
    return;
  }
  const PRI = { P0:'#fca5a5', P1:'#fcd34d', P2:'#94a3b8' };
  const MODE = { read:'只读', draft:'生成草稿', commit:'写入（需确认）', async_task:'异步任务' };
  box.innerHTML = '';
  const wrap = el('div');
  wrap.appendChild(el('div', 'tiny', `已加载 <b>${data.count}</b> 个技能 · 位于 hzj-ai-aftersales/skills/ · 格式为 SKILL.md（YAML frontmatter + Markdown 指令）`));
  box.appendChild(wrap);

  const pv = el('div', 'row', { });
  const btnPv = el('button', 'btn ghost sm', '🔍 预览注入后的提示词');
  btnPv.onclick = async () => {
    const t = ($('#chatText') && $('#chatText').value.trim()) || '欧盟客户的退货政策是什么，客户要退款';
    btnPv.textContent = '组装中…'; btnPv.disabled = true;
    try {
      const r = await fetch('/api/prompt-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t })
      }).then(x => x.json());
      if (!r.ok) { toast(r.error || '组装失败', false); return; }
      $('#modalTitle').textContent = '注入后的系统提示词（真实组装结果）';
      $('#modalBody').innerHTML =
        '<div class="kv"><span>触发文本</span><span>' + esc(t.slice(0, 40)) + '</span></div>' +
        '<div class="kv"><span>命中技能</span><span>' + esc(r.matched_skills.join('、')) + '</span></div>' +
        '<div class="kv"><span>字符数</span><span>基础 ' + r.base_prompt_chars + ' + 技能 ' + r.skill_block_chars + ' = <b>' + r.total_chars + '</b></span></div>' +
        '<div class="tiny" style="margin:10px 0 6px">接上模型后，这段内容会作为 system prompt 发出：</div>' +
        '<pre style="max-height:46vh;overflow:auto;background:#0a0d12;padding:10px;border-radius:7px;font-size:11px;line-height:1.6;white-space:pre-wrap">' + esc(r.composed_prompt) + '</pre>';
      $('#modal').classList.add('on');
    } catch (e) { toast('失败：' + e.message, false); }
    finally { btnPv.textContent = '🔍 预览注入后的提示词'; btnPv.disabled = false; }
  };
  pv.appendChild(btnPv);
  wrap.appendChild(pv);

  data.skills.forEach(sk => {
    const c = el('div', 'skillcard');
    const nm = el('div', 'sk-name');
    nm.appendChild(el('span', null, esc(sk.name_zh)));
    nm.appendChild(el('span', 'tag', esc(sk.priority)));
    nm.appendChild(el('span', 'tag', esc(sk.version)));
    c.appendChild(nm);
    c.appendChild(el('div', 'sk-desc', esc(sk.description)));
    const mount = '挂载：<b>' + esc(sk.target_agent || '-') + '</b> · 写入模式：' + esc(MODE[sk.action_mode] || sk.action_mode) +
                  (sk.requires_confirmation ? ' · <span style="color:#fcd34d">需人工确认</span>' : '');
    c.appendChild(el('div', 'tiny', mount));
    const meta = el('div', 'sk-meta');
    meta.appendChild(el('span', null, 'id: ' + esc(sk.name)));
    meta.appendChild(el('span', null, '触发词 ' + (sk.triggers || []).length));
    meta.appendChild(el('span', null, '正文 ' + sk.body_lines + ' 行'));
    meta.appendChild(el('span', null, esc(sk.file)));
    c.appendChild(meta);
    box.appendChild(c);
  });
}
/* ---------------- 审计日志 ----------------
   记录每一次分析的完整调用链，用于事后追责与效果复盘。
   注意与 logs/requests.log 区分：那是 HTTP 流水，这里是业务语义。 */
async function renderAudit() {
  const box = $('#auditList');
  if (!box) return;
  box.innerHTML = '<div class="hint">加载中…</div>';
  let d = null;
  try { d = await fetch('/api/audit').then(x => x.json()); } catch (e) {}
  if (!d || !d.ok) { box.innerHTML = '<div class="hint">读不到审计日志（本地服务未启动？）</div>'; return; }

  const meta = $('#auditMeta');
  if (meta) meta.textContent = '最近 ' + d.count + ' 条';

  if (!d.count) {
    box.innerHTML = '<div class="empty-state">还没有记录<br><span>生成一次话术之后，这里会出现完整的调用链</span></div>';
    return;
  }
  box.innerHTML = '';
  const COV = { sufficient: 'var(--ok)', partial: 'var(--warn)', insufficient: 'var(--bad)' };
  d.entries.forEach(function (e) {
    const c = el('div', 'audititem');
    const hd = el('div', 'row');
    hd.appendChild(el('span', 'auditts', esc(e.ts || '')));
    hd.appendChild(el('span', 'tag st', esc(e.intent || '-')));
    hd.appendChild(el('span', 'tag', esc((e.country || '-') + ' / ' + (e.platform || '-'))));
    hd.appendChild(el('span', 'tag ' + (e.urgency === 'critical' ? 'rj' : e.urgency === 'high' ? 'rv' : ''), esc(e.urgency || '-')));
    if (e.need_human) hd.appendChild(el('span', 'tag rj', '高风险：' + esc(e.esc_reason || '')));
    hd.appendChild(el('span', 'auditms', (e.latency_ms || 0) + 'ms'));
    c.appendChild(hd);

    const g = el('div', 'auditgrid');
    g.appendChild(kv('情绪', esc(e.emotion || '-')));
    g.appendChild(kv('知识覆盖', '<span style="color:' + (COV[e.coverage] || 'inherit') + '">' + esc(e.coverage || '-') + '</span>'));
    g.appendChild(kv('候选 / 推荐', (e.candidates || 0) + ' 条 / ' + esc(e.recommended || '-')));
    g.appendChild(kv('生成方式', e.generated_by === 'model' ? '外部模型' : '本地模板'));
    g.appendChild(kv('命中技能', esc((e.skills || []).join('、') || '无')));
    g.appendChild(kv('注入提示词', (e.prompt_chars || 0) + ' 字符'));
    c.appendChild(g);

    if ((e.evidence || []).length) {
      const ev = el('div', 'auditev');
      ev.appendChild(el('span', 'tiny', '依据政策：'));
      e.evidence.forEach(function (id) { ev.appendChild(el('span', 'tag', esc(id))); });
      c.appendChild(ev);
    } else {
      c.appendChild(el('div', 'tiny', '⚠ 本次没有检索到政策依据'));
    }
    if (e.input_head) c.appendChild(el('div', 'auditin', '输入：' + esc(e.input_head) + ((e.input_chars || 0) > 120 ? ' …' : '')));
    box.appendChild(c);
  });
}

function renderKB() {
  const box = $('#kbTable');
  if (!box) return;
  const h = window.__HEALTH;
  const d = (h && h.data) || {};
  const rows = [
    { name:'policy_kb', label:'各国政策库', meta:'20 条政策 · 含生效日期 · 检索强制时效过滤', ok:true },
    { name:'compliance_rules', label:'合规规则库', meta:'30 条可执行正则 · violation / obligation 两层', ok:true },
    { name:'glossary', label:'服装术语库', meta:'46 条 · 中英西德法', ok:true },
    { name:'intent_taxonomy', label:'意图标签库', meta:'14 类 · 多语言信号词', ok:true },
    { name:'case_kb', label:'优质案例库', meta:'种子阶段为空，需从试点商户沉淀', ok:false },
    { name:'product_kb', label:'产品知识库', meta:'待接入商户真实产品与尺码数据', ok:false }
  ];
  box.innerHTML = '';
  rows.forEach(r => {
    const row = el('div', 'kbrow');
    row.appendChild(el('div', 'kbname', esc(r.label)));
    row.appendChild(el('div', 'kbmeta', esc(r.meta)));
    row.appendChild(el('div', 'kbstat ' + (r.ok ? 'ok' : 'off'), r.ok ? '已加载' : '待接入'));
    box.appendChild(row);
  });
  if (d.compliance_rules) {
    box.appendChild(el('div', 'hint',
      `当前加载：合规规则 ${d.compliance_rules} 条 / 术语 ${d.glossary} 条 / 政策 ${d.policy_index} 条 / 意图 ${d.intent_taxonomy} 类`));
  }
}

function renderSettings() {
  const h = window.__HEALTH;
  const m = (h && h.model) || { mode:'local-fallback', provider:'local' };

  const mb = $('#setModel');
  if (mb) {
    mb.innerHTML = '';
    mb.appendChild(kv('生效模式', m.mode === 'model' ? '<span style="color:var(--ok)">外部模型</span>' : '本地规则引擎'));
    mb.appendChild(kv('provider', esc(m.provider || 'local')));
    mb.appendChild(kv('endpoint', m.endpoint_set ? esc(m.endpoint || '已设置') : '（未设置）'));
    mb.appendChild(kv('模型名', m.model ? esc(m.model) : '（未设置）'));
    mb.appendChild(el('div', 'hint', '接入方法：复制 <code>config.example.json</code> 为 <code>config.local.json</code>，改 provider 与 endpoint，再用 <code>tools\\set-api-key.ps1</code> 存密钥。'));
  }

  const kb = $('#setKey');
  if (kb) {
    kb.innerHTML = '';
    kb.appendChild(kv('状态', m.has_key ? '<span style="color:var(--ok)">已配置</span>' : '<span style="color:var(--warn)">未配置</span>'));
    if (m.has_key) {
      kb.appendChild(kv('指纹', esc(m.key_fingerprint || '')));
      kb.appendChild(kv('更新时间', esc(m.key_updated_at || '')));
    }
    kb.appendChild(kv('存储位置', '<span style="font-size:11px">' + esc(m.key_store || '') + '</span>'));

    // 直接在界面里填自己的 API Key —— 别人拿到本项目后无需改文件、无需命令行
    const inp = el('input', 'sel');
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.style.marginTop = '10px';
    inp.placeholder = m.has_key ? '已配置（留空则不改动）' : '粘贴你的百度千帆 API Key（bce-v3-…）';
    kb.appendChild(inp);

    const msgEl = el('div', 'hint', '');
    const row = el('div', 'row');
    row.style.marginTop = '9px';

    const bs = el('button', 'btn primary sm', '保存');
    bs.onclick = async () => {
      const v = inp.value.trim();
      if (!v) { msgEl.innerHTML = '<span style="color:var(--warn)">请先填入 Key</span>'; return; }
      bs.disabled = true; bs.textContent = '保存中…';
      try {
        const r = await fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: v, provider: 'qianfan' })
        }).then(x => x.json());
        if (!r.ok) {
          msgEl.innerHTML = '<span style="color:var(--bad)">' + esc(r.error || '保存失败') + '</span>';
        } else {
          inp.value = '';   // 存完立刻清空，不在页面上留着密钥
          msgEl.innerHTML = '<span style="color:var(--ok)">✓ ' + esc((r.changed || []).join('，')) +
                            ' · 指纹 ' + esc(r.model.key_fingerprint || '') + '</span>';
          toast('API Key 已保存（DPAPI 加密）');
          health();
        }
      } catch (e) {
        msgEl.innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>';
      }
      bs.disabled = false; bs.textContent = '保存';
    };
    row.appendChild(bs);

    const bc = el('button', 'btn ghost sm', '清除 Key');
    bc.onclick = async () => {
      bc.disabled = true;
      try {
        const r = await fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: '' })
        }).then(x => x.json());
        if (r.ok) { toast('已清除 API Key'); await health(); renderSettings(); }
        else { toast(r.error || '清除失败', false); }
      } catch (e) { toast(e.message, false); }
      bc.disabled = false;
    };
    row.appendChild(bc);
    kb.appendChild(row);
    kb.appendChild(msgEl);
    kb.appendChild(el('div', 'hint',
      '🔒 Key 用 Windows DPAPI 加密后只存本机，接口永不回显。获取方式：百度智能云 → 千帆 ModelBuilder → 模型服务 → API Key。'));
  }

  // 知识源（本地 CSV / 千帆知识库）
  const kbb = $('#setKb');
  if (kbb) {
    kbb.innerHTML = '<div class="hint">加载中…</div>';
    fetch('/api/knowledge').then(x => x.json()).then(function (d) {
      const k = (d && d.knowledge) || {};
      kbb.innerHTML = '';
      kbb.appendChild(kv('当前生效', '<b>' + esc(k.active_label || '-') + '</b>'));
      kbb.appendChild(kv('本地知识库', (k.local_ready ? '✅ 就绪 · ' + k.local_count + ' 条政策' : '❌ 未加载')));
      kbb.appendChild(kv('千帆知识库', (k.qianfan_ready ? '✅ 已配置' : '⬜ 未配置')));
      if (k.degraded) {
        kbb.appendChild(el('div', 'banner warn', '⚠ 已降级：' + esc(k.degrade_reason || '')));
      }

      const sel = el('select', 'sel');
      [['local', '本地 CSV 知识库（开箱即用）'], ['qianfan', '千帆知识库（MCP / AppBuilder）']].forEach(function (o) {
        const op = el('option'); op.value = o[0]; op.textContent = o[1];
        if (o[0] === k.configured) op.selected = true;
        sel.appendChild(op);
      });
      sel.style.marginTop = '10px';

      const ep = el('input', 'sel');
      ep.placeholder = '千帆检索端点，如 http://127.0.0.1:8080/mcp/search';
      ep.value = k.qianfan_endpoint || '';
      ep.style.marginTop = '8px';
      const aid = el('input', 'sel');
      aid.placeholder = 'AppBuilder 应用 ID（选填）'; aid.value = k.qianfan_app_id || ''; aid.style.marginTop = '8px';
      const ds = el('input', 'sel');
      ds.placeholder = '知识库 / 数据集 ID（选填）'; ds.value = k.qianfan_dataset || ''; ds.style.marginTop = '8px';

      const msg = el('div', 'hint', '');
      const row = el('div', 'row'); row.style.marginTop = '10px';

      const bs = el('button', 'btn primary sm', '保存');
      bs.onclick = async function () {
        bs.disabled = true; bs.textContent = '保存中…';
        try {
          const r = await fetch('/api/knowledge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: sel.value, qianfan_endpoint: ep.value.trim(),
                                   qianfan_app_id: aid.value.trim(), qianfan_dataset: ds.value.trim() })
          }).then(x => x.json());
          if (!r.ok) msg.innerHTML = '<span style="color:var(--bad)">' + esc(r.error || '保存失败') + '</span>';
          else { toast('已保存' + (r.knowledge.degraded ? '（当前降级到本地）' : '')); renderSettings(); return; }
        } catch (e) { msg.innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; }
        bs.disabled = false; bs.textContent = '保存';
      };
      row.appendChild(bs);

      const bt = el('button', 'btn ghost sm', '测试连接');
      bt.onclick = async function () {
        bt.disabled = true; bt.textContent = '测试中…';
        try {
          const r = await fetch('/api/knowledge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test: true })
          }).then(x => x.json());
          const t = r.result || {};
          msg.innerHTML = t.ok
            ? '<span style="color:var(--ok)">✓ 连接成功（' + t.latency_ms + 'ms，返回 ' + (t.sample || []).length + ' 条样本）</span>'
            : '<span style="color:var(--warn)">✕ ' + esc(t.reason || '失败') + '（' + t.latency_ms + 'ms）</span>';
        } catch (e) { msg.innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; }
        bt.disabled = false; bt.textContent = '测试连接';
      };
      row.appendChild(bt);
      kbb.appendChild(sel); kbb.appendChild(ep); kbb.appendChild(aid); kbb.appendChild(ds);
      kbb.appendChild(row); kbb.appendChild(msg);
      kbb.appendChild(el('div', 'hint', '⚠ 千帆路径尚未对接真实接口，契约见 docs/接入千帆知识库.md 第三节；字段名不同只需改 engine/knowledge.ps1 的映射。'));
    }).catch(function () { kbb.innerHTML = '<div class="hint">读不到知识源状态（本地服务未启动？）</div>'; });
  }

  // 自定义禁用表述
  const rb = $('#setRules');
  if (rb) {
    rb.innerHTML = '<div class="hint">加载中…</div>';
    fetch('/api/custom-rules').then(x => x.json()).then(function (d) {
      rb.innerHTML = '';
      const list = (d && d.rules) || [];

      // 新增表单
      const ti = el('input', 'sel'); ti.placeholder = '规则名（如：禁止概不退换）';
      const pi = el('input', 'sel'); pi.placeholder = '关键词或正则（如：概不退换|不退不换）';
      const si = el('select', 'sel');
      [['warn', '警告（标记为需修订）'], ['block', '拦截（直接判为不可发送）']].forEach(function (o) {
        const op = el('option'); op.value = o[0]; op.textContent = o[1]; si.appendChild(op);
      });
      si.style.maxWidth = '200px';
      const ri = el('input', 'sel'); ri.placeholder = '原因（选填，会显示给坐席）';
      const gi = el('input', 'sel'); gi.placeholder = '改写建议（选填）';

      const row1 = el('div', 'row'); row1.style.marginTop = '4px';
      row1.appendChild(ti); row1.appendChild(pi);
      const row2 = el('div', 'row'); row2.style.marginTop = '8px';
      row2.appendChild(si); row2.appendChild(ri);
      const row3 = el('div', 'row'); row3.style.marginTop = '8px';
      row3.appendChild(gi);

      const btn = el('button', 'btn primary sm', '＋ 添加规则');
      const msg = el('div', 'hint', '');
      btn.onclick = async function () {
        if (!pi.value.trim()) { msg.innerHTML = '<span style="color:var(--warn)">请填写关键词或正则</span>'; return; }
        btn.disabled = true; btn.textContent = '添加中…';
        try {
          const r = await fetch('/api/custom-rules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: ti.value.trim() || '自定义禁用表述', pattern: pi.value.trim(),
                                   severity: si.value, reason: ri.value.trim(), suggestion: gi.value.trim() })
          }).then(x => x.json());
          if (!r.ok) { msg.innerHTML = '<span style="color:var(--bad)">' + esc(r.error || '添加失败') + '</span>'; }
          else if (r.warnings && r.warnings.length) {
            // 规则太宽会误杀合规话术 —— 当场提示，别让用户回头发现话术全被拦
            msg.innerHTML = '<span style="color:var(--warn)">⚠ ' +
              esc(r.warnings.join('<br>')).replace(/&lt;br&gt;/g, '<br>') + '</span>';
            toast('已添加，但可能过于宽泛', false);
            return;
          }
          else { toast('已添加，立即生效'); renderSettings(); return; }
        } catch (e) { msg.innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; }
        btn.disabled = false; btn.textContent = '＋ 添加规则';
      };
      const row4 = el('div', 'row'); row4.style.marginTop = '10px';
      row4.appendChild(btn);
      rb.appendChild(row1); rb.appendChild(row2); rb.appendChild(row3); rb.appendChild(row4); rb.appendChild(msg);

      // 现有规则
      if (!list.length) {
        rb.appendChild(el('div', 'hint', '还没有自定义规则。上方添加后，候选话术会被即时校验。'));
      } else {
        rb.appendChild(el('div', 'an-title', '已启用 ' + list.length + ' 条'));
        list.forEach(function (r) {
          const c = el('div', 'ruleitem');
          const hdRow = el('div', 'row');
          const tag = el('span', 'tag ' + (r.severity === 'block' ? 'rj' : 'rv'),
                         r.severity === 'block' ? '拦截' : '警告');
          hdRow.appendChild(tag);
          hdRow.appendChild(el('span', 'ruleid', esc(r.id)));
          hdRow.appendChild(el('span', 'ruletitle', esc(r.title || '')));
          if (!r.valid) hdRow.appendChild(el('span', 'tag rj', '正则非法·未生效'));
          const del = el('button', 'btn ghost sm', '删除');
          del.style.marginLeft = 'auto';
          del.onclick = async function () {
            del.disabled = true;
            const rr = await fetch('/api/custom-rules', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ delete: r.id })
            }).then(x => x.json());
            if (rr.ok) { toast('已删除'); renderSettings(); } else { toast(rr.error || '删除失败', false); del.disabled = false; }
          };
          hdRow.appendChild(del);
          c.appendChild(hdRow);
          c.appendChild(el('div', 'rulepat', '匹配：' + esc(r.pattern)));
          if (r.reason) c.appendChild(el('div', 'tiny', '原因：' + esc(r.reason)));
          if (r.suggestion) c.appendChild(el('div', 'tiny', '建议：' + esc(r.suggestion)));
          rb.appendChild(c);
        });
      }
    }).catch(function () { rb.innerHTML = '<div class="hint">读不到规则列表（本地服务未启动？）</div>'; });
  }

  const rd = $('#setReaders');
  if (rd) {
    rd.innerHTML = '';
    rd.appendChild(kv('窗口直读（UI Automation）', h && h.uia_available ? '✅ 可用' : '❌ 不可用'));
    rd.appendChild(kv('剪贴板监听', h && h.clipboard_available ? '✅ 可用' : '❌ 不可用'));
    const langs = (h && h.ocr_languages) || [];
    rd.appendChild(kv('读屏 OCR', langs.length ? '✅ ' + langs.join(', ') : '❌ 未安装语言包'));
  }
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
      b.title = '未接入外部模型。配置方法见 hzj-ai-aftersales/README.md 与 config.example.json';
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

    // 左侧导航底部的连接状态
    const sd = $('#sideDot'), ss = $('#sideStatus'), sm = $('#sideModel');
    if (sd) sd.className = 'dot on';
    if (ss) ss.textContent = '已连接 127.0.0.1:8799';
    if (sm) sm.textContent = m.mode === 'model' ? ('模型：' + (m.provider || '')) : '模型：本地规则';

    // 若当前正停在设置/知识库页，刷新其内容
    if (currentPage === 'settings') renderSettings();
    if (currentPage === 'kb') renderKB();
  } catch (e) {
    $('#kbBadge').textContent = '服务未连接';
    const sd = $('#sideDot'), ss = $('#sideStatus');
    if (sd) sd.className = 'dot off';
    if (ss) ss.textContent = '未连接';
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
      renderChat();
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
        renderChat();
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
        renderChat();
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
    // 建议原文：服务端用它算"人工修改幅度"（相似度）。
    // 只知道"改没改"不够，要知道"改了多少"才反映建议质量。
    suggested_text: cand.text_zh || '',
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
    const al = el('div', 'alert risk');
    al.innerHTML = `<b>⚠ 高风险案件</b>（${esc(ESC_ZH[esc_.reason] || esc_.reason || '')}）<br>` +
      `回复前请核对下方<b>政策依据</b>，避免口径与该国法规或平台规则冲突。`;
    box.appendChild(al);
  } else {
    box.appendChild(el('div', 'alert ok', '<b>✓ 常规案件</b><br>候选话术已通过合规校验，核对政策依据后可使用。'));
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

  // 工单路由 + SLA（来自 ecommerce-intent-routing 技能）
  if (res.routing) {
    const sr = el('div', 'an-sec');
    sr.appendChild(el('div', 'an-title', '工单路由（技能驱动）'));
    sr.appendChild(kv('分派组', '<b>' + esc(res.routing.group) + '</b>'));
    sr.appendChild(kv('SLA 时限', esc(res.routing.sla)));
    if (res.routing.risk && res.routing.risk !== '—') sr.appendChild(kv('风险提示', esc(res.routing.risk)));
    sr.appendChild(el('div', 'tiny', '来源技能：' + esc(res.routing.source)));
    box.appendChild(sr);
  }

  // 情绪安抚策略（来自 customer-reply-craft 技能，按情绪强度自动选级）
  if (res.calming) {
    const sc = el('div', 'an-sec');
    sc.appendChild(el('div', 'an-title', '情绪安抚策略（技能驱动）'));
    sc.appendChild(kv('情绪级别', '<b>' + res.calming.level + ' / 5</b>'));
    sc.appendChild(kv('处理方式', esc(res.calming.action)));
    if (res.calming.forbidden && res.calming.forbidden !== '—') {
      sc.appendChild(kv('禁止', '<span style="color:#fca5a5">' + esc(res.calming.forbidden) + '</span>'));
    }
    sc.appendChild(el('div', 'tiny', '来源技能：' + esc(res.calming.source)));
    box.appendChild(sc);
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
  emitResultLog(res);          // 把这次结果展开成运行日志
}

/* 把管线结果展开成逐节点日志。
   ⚠️ 说明：后端目前只返回最终结果，所以这里是**从结果推导**出各节点状态，
   不是后端真实上报的执行日志。等后端把每节点的输入/输出/耗时/理由记下来，
   这里改成直接读真实日志即可（接口形状保持一致）。 */
function emitResultLog(res) {
  const a = res.analysis, rt = res.retrieval, tr = res.translation, mt = res.meta || {};

  // 翻译
  if (tr && tr.status) {
    const ok = tr.detected_lang === 'zh' || !!tr.translated_text;
    pushLog('translate', ok ? 'ok' : 'warn',
      ok ? `识别为 <b>${esc(tr.detected_lang.toUpperCase())}</b>` + (tr.glossary_hits && tr.glossary_hits.length ? ` · 术语命中 ${tr.glossary_hits.length}` : '')
         : esc(tr.status),
      null, 'agent');
  }
  // 意图情绪
  if (a) {
    pushLog('intent', 'ok',
      `主意图 <b>${esc(a.primary_intent_zh || a.primary_intent)}</b> · 情绪 ${esc(a.emotion.polarity)}/${a.emotion.intensity} · 紧急度 ${esc(a.urgency)}`,
      null, 'agent');
    if ((a.risk_flags || []).length) {
      pushLog('intent', 'warn', '风险标记：' + a.risk_flags.map(r => esc(RISK_ZH[r] || r)).join('、'), null, 'agent');
    }
  }
  // 技能命中（触发词机制：不是全量塞进提示词，只取本次相关的）
  if (mt.skills && mt.skills.length) {
    pushLog('skill', 'ok',
      '按触发词命中 <b>' + mt.skills.length + '</b> 个技能：' + mt.skills.map(esc).join('、') +
      (mt.composed_prompt_chars ? ' · 注入提示词 <b>' + mt.composed_prompt_chars + '</b> 字符' : ''), null, 'agent');
    (res.skill_application || []).forEach(function (line) { pushLog('skill', 'ok', esc(line), null, 'agent'); });
  }
  // 查询改写
  if (rt && rt.queries) {
    pushLog('rewrite', 'ok', `生成 <b>${rt.queries.length}</b> 条检索 query · 路由 ${(rt.kb_route || []).map(esc).join(' / ')}`, null, 'agent');
  }
  // 检索
  if (rt) {
    const n = (rt.evidence || []).length;
    const cov = rt.coverage;
    pushLog('retrieve', cov === 'sufficient' ? 'ok' : cov === 'partial' ? 'warn' : 'err',
      `命中 <b>${n}</b> 条证据 · 覆盖度 ${esc(cov)}` +
      (n ? ' · ' + rt.evidence.slice(0, 3).map(e => esc(e.doc_id)).join(', ') : ''),
      null, 'retrieval');
    (rt.evidence || []).forEach(e => {
      pushLog('retrieve', 'ok', `[${esc(e.doc_id)}] ${esc(e.title)} <span style="color:#4d5666">匹配 ${e.score} · 生效 ${esc(e.effective_date || '-')}</span>`, null, 'retrieval');
    });
  }
  // 话术生成
  if (res.candidates) {
    pushLog('generate', 'ok',
      `产出 <b>${res.candidates.length}</b> 条候选 · 来源 ${mt.generated_by === 'model' ? '模型' : '本地模板'}` +
      (mt.model_used && mt.model_used.length ? ' · ' + mt.model_used.map(esc).join('、') : ''),
      null, 'agent');
  }
  // 合规
  (res.compliance || []).forEach(c => {
    const st = c.decision === 'pass' ? 'ok' : c.decision === 'revise' ? 'warn' : 'err';
    const vs = (c.violations || []).map(v => `[${esc(v.rule_id)}] ${esc(v.title || v.reason)}`).join('；');
    pushLog('compliance', st,
      `${esc(c.candidate_id)}/${esc(c.style)} → <b>${c.decision}</b>` + (vs ? ' · ' + vs : ''),
      null, 'compliance');
  });
  // 主控汇总
  pushLog('orchestrate', res.escalation && res.escalation.need_human ? 'warn' : 'ok',
    `推荐 <b>${esc(res.final.recommended_candidate_id || '无')}</b> · ${res.escalation && res.escalation.need_human ? '标记为高风险案件' : '常规案件'}` +
    ` · 总耗时 ${mt.latency_ms || 0}ms`,
    null, 'agent');
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
    // 人工修改幅度：比采纳率更能反映建议准不准
    if (r.edit_samples) {
      const eb = el('div', 'an-sec');
      eb.appendChild(el('div', 'an-title', '人工修改幅度（' + r.edit_samples + ' 条样本）'));
      eb.appendChild(kv('平均相似度', '<b>' + r.edit_avg + '</b>'));
      eb.appendChild(kv('总体判定', '<b>' + esc(r.edit_verdict || '') + '</b>'));
      const bars = el('div');
      const bk = r.edit_buckets || {};
      const mx = Math.max.apply(null, Object.keys(bk).map(function (k) { return bk[k]; }).concat([1]));
      Object.keys(bk).forEach(function (k) {
        const rowEl = el('div', 'barrow');
        rowEl.appendChild(el('span', 'barlbl', esc(k)));
        const b = el('div', 'bar');
        b.appendChild(el('i', null, ''));
        b.firstChild.style.width = Math.round(bk[k] / mx * 100) + '%';
        rowEl.appendChild(b);
        rowEl.appendChild(el('span', 'barval', String(bk[k])));
        bars.appendChild(rowEl);
      });
      eb.appendChild(bars);
      eb.appendChild(el('div', 'tiny', '相似度 1.0 = 坐席原样使用；越低说明建议被改得越多。'));
      $('#modalBody').appendChild(eb);
    }

    $('#modalTitle').textContent = '数据闭环 · 采纳统计';
    $('#modal').classList.add('on');
  } catch (e) { toast('读取失败', false); }
}

/* ---------------- 事件绑定 ---------------- */
const DEMO = `AI客服: 您好，请问有什么可以帮您？
Buyer: The dress arrived with stains and I want my money back
AI客服: 很抱歉给您带来不便，我这边只能为您登记，具体方案需要售后专员为您处理。
Buyer: I have been waiting 10 days already
AI客服: 已为您转接人工客服，请稍候。
Seller: So sorry, let me check your order
Buyer: If you don't handle this I will complain to the platform
Seller: Let me look into it for you right away.`;

// 左侧导航
document.querySelectorAll('#sideNav .nav-item').forEach(b => {
  b.onclick = () => { setPage(b.dataset.page); location.hash = b.dataset.page; };
});

// 对话内容变化 → 实时重绘气泡与统计
$('#chatText').addEventListener('input', renderChat);

// 原始文本展开/收起
$('#btnToggleRaw').onclick = () => {
  const ta = $('#chatText');
  const hidden = ta.classList.toggle('hidden');
  $('#btnToggleRaw').textContent = hidden ? '展开' : '收起';
};

// 日志面板：折叠展开 / 筛选 / 清空
$('#logHead').onclick = (e) => {
  if (e.target.closest('.logfilters') || e.target.closest('#btnClearLog')) return;
  $('#logPanel').classList.toggle('collapsed');
  $('#logChev').textContent = $('#logPanel').classList.contains('collapsed') ? '▶' : '▼';
};
document.querySelectorAll('#logFilters .lf').forEach(b => {
  b.onclick = (e) => {
    e.stopPropagation();
    LOG.filter = b.dataset.f;
    document.querySelectorAll('#logFilters .lf').forEach(x => x.classList.toggle('active', x === b));
    renderLog();
  };
});
$('#btnClearLog').onclick = (e) => { e.stopPropagation(); clearLog(); toast('日志已清空'); };

document.querySelectorAll('#tabs .tab').forEach(t => {
  t.onclick = () => setMode(t.dataset.mode);
});
$('#btnRefreshWins').onclick = loadWindows;
$('#btnUiaWatch').onclick = () => state.uiaWatching ? stopUiaWatch() : startUiaWatch();
$('#btnClipWatch').onclick = () => state.clipWatching ? stopClipWatch() : startClipWatch();
$('#btnCapture').onclick = () => state.capturing ? stopCapture() : startCapture();
$('#btnAnalyze').onclick = () => analyzeText(false);
$('#btnClear').onclick = () => {
  $('#chatText').value = ''; state.lastReadText = '';
  setReadStatus(''); renderChat();
};
$('#btnDemo').onclick = () => {
  $('#chatText').value = DEMO;
  state.lastReadText = DEMO;
  $('#selCountry').value = 'ES';
  $('#selPlatform').value = 'tiktok_shop';
  $('#selCategory').value = 'dress';
  renderChat();
  toast('已填充演示样本（含 AI 客服转人工的上下文）');
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

// 页面深链：#workbench / #tasks / #skills / #kb / #settings
var _hashPage = (location.hash || '').replace('#','').trim();
if (_hashPage && PAGE_TITLE[_hashPage]) setPage(_hashPage); else setPage('workbench');

renderChat();
renderLog();
health();
setMode('uia');
