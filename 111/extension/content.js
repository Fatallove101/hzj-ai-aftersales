/* =====================================================================
   content.js  ·  侧边栏主体
   在客服后台右侧注入一个面板：读取对话 → 生成话术 → 一键插入输入框
   用 Shadow DOM 隔离样式，避免与宿主页面互相污染。
   ===================================================================== */

(function () {
  'use strict';

  const AIH = window.AIH;
  if (!AIH) return;
  if (window.__AIH_MOUNTED__) {           // 防止重复注入
    if (AIH.__panel) AIH.__panel.toggle();
    return;
  }
  window.__AIH_MOUNTED__ = true;

  const state = {
    adapter: null,
    selectors: {},
    overrides: {},
    messages: [],
    lastText: '',
    lastResult: null,
    serverOk: false,
    serverMsg: '',
    watching: false,
    timer: null,
    observer: null,
    busy: false,
    visible: true,
    targetLang: 'en',
    country: 'UNKNOWN',
    platform: 'unknown'
  };

  const PANEL_W = 392;
  const HOST = location.hostname;
  const STORE_KEY = 'site:' + HOST;

  /* ---------------- 小工具 ---------------- */
  function h(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'class') n.className = props[k];
        else if (k === 'text') n.textContent = props[k];
        else if (k === 'html') n.innerHTML = props[k];
        else if (k.startsWith('on') && typeof props[k] === 'function') n.addEventListener(k.slice(2), props[k]);
        else if (props[k] != null) n.setAttribute(k, props[k]);
      }
    }
    (children || []).forEach(c => { if (c) n.appendChild(c); });
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function msg(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload ? { payload } : {}), res => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: '无响应' });
        });
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  const CSS = `
:host{all:initial;--panelw:392px}
*{box-sizing:border-box;font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif}
.panel{position:fixed;top:0;right:0;width:var(--panelw);height:100vh;background:#0e1116;color:#e6e9ef;
  border-left:1px solid #252c38;display:flex;flex-direction:column;z-index:2147483645;
  box-shadow:-8px 0 28px rgba(0,0,0,.45);font-size:13px;line-height:1.55}
.panel.hidden{display:none}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #252c38;background:#12161d;flex:0 0 auto}
.logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#3b82f6,#a78bfa);
  display:grid;place-items:center;font-weight:800;font-size:11px;color:#fff;flex:0 0 auto}
.ttl{font-weight:700;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bd{flex:1 1 auto;overflow-y:auto;padding:12px}
.bd::-webkit-scrollbar{width:8px}.bd::-webkit-scrollbar-thumb{background:#2a3240;border-radius:4px}
.ft{flex:0 0 auto;padding:9px 12px;border-top:1px solid #252c38;background:#12161d;display:flex;gap:6px;align-items:center}
.btn{border:1px solid #252c38;background:#1c212b;color:#e6e9ef;padding:6px 11px;border-radius:7px;
  cursor:pointer;font-size:12px;font-family:inherit;transition:.15s;white-space:nowrap}
.btn:hover{background:#232a36;border-color:#334054}
.btn.pri{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:600}
.btn.pri:hover{background:#2f74e0}
.btn.dan{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.5);color:#fca5a5}
.btn.sm{padding:4px 8px;font-size:11.5px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.sel{background:#1c212b;color:#e6e9ef;border:1px solid #252c38;border-radius:6px;padding:5px 7px;font-size:11.5px;width:100%}
.card{background:#161a22;border:1px solid #252c38;border-radius:9px;padding:11px;margin-bottom:11px}
.sec{font-size:10.5px;color:#6b7480;letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px}
.banner{padding:9px 11px;border-radius:8px;font-size:12px;margin-bottom:11px;line-height:1.6}
.banner.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:#fca5a5}
.banner.ok{background:rgba(34,197,94,.09);border:1px solid rgba(34,197,94,.3);color:#86efac}
.banner.warn{background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.32);color:#fcd34d}
.kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:12px;border-bottom:1px solid rgba(255,255,255,.045)}
.kv:last-child{border-bottom:none}
.kv span:first-child{color:#6b7480;flex:0 0 auto}
.kv span:last-child{text-align:right;font-weight:600;word-break:break-all}
.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;margin:0 4px 4px 0}
.pill.i{background:rgba(59,130,246,.16);color:#93c5fd}
.pill.r{background:rgba(239,68,68,.16);color:#fca5a5}
.pill.s{background:rgba(167,139,250,.16);color:#c4b5fd}
.pill.t{background:rgba(34,197,94,.14);color:#86efac}
.cand{border:1px solid #252c38;border-radius:8px;background:#1c212b;margin-bottom:9px;overflow:hidden}
.cand.rec{border-color:rgba(34,197,94,.55)}
.cand.rej{opacity:.5;border-color:rgba(239,68,68,.4)}
.ch{display:flex;gap:6px;align-items:center;padding:7px 9px;border-bottom:1px solid #252c38;flex-wrap:wrap;font-size:11px}
.tag{padding:2px 7px;border-radius:5px;background:#2a3342;color:#c6d0dd}
.tag.st{background:rgba(167,139,250,.16);color:#c4b5fd}
.tag.ok{background:rgba(34,197,94,.15);color:#86efac}
.tag.rv{background:rgba(245,158,11,.16);color:#fcd34d}
.tag.rj{background:rgba(239,68,68,.16);color:#fca5a5}
.cb{padding:9px 10px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.cb.zh{border-top:1px dashed #252c38;color:#9fb0c4;font-size:11.5px}
.cf{display:flex;gap:5px;padding:7px 9px;border-top:1px solid #252c38;flex-wrap:wrap;align-items:center;background:rgba(0,0,0,.15)}
.vio{margin:0 9px 8px;padding:7px 9px;border-radius:6px;background:rgba(245,158,11,.08);
  border-left:3px solid #f59e0b;font-size:11.5px;line-height:1.6}
.vio.blk{background:rgba(239,68,68,.08);border-left-color:#ef4444}
.tiny{font-size:11px;color:#6b7480;line-height:1.6}
.empty{text-align:center;padding:28px 12px;color:#6b7480;font-size:12px;line-height:1.8}
/* 政策依据 */
.ev{background:#1c212b;border:1px solid #252c38;border-radius:7px;padding:8px 10px;margin-bottom:7px}
.ev .evt{font-weight:600;font-size:12px;color:#c9d4e0;margin-bottom:3px}
.ev .evs{font-size:11.5px;color:#98a2b3;line-height:1.6}
.ev .evm{font-size:10px;color:#6b7480;margin-top:5px}
.pv{max-height:96px;overflow-y:auto;background:#11151c;border:1px solid #252c38;border-radius:7px;
  padding:7px 8px;font-size:11.5px;color:#9fb0c4;white-space:pre-wrap;line-height:1.6}
.fab{position:fixed;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;z-index:2147483645;
  background:linear-gradient(135deg,#3b82f6,#a78bfa);color:#fff;border:none;cursor:pointer;
  font-weight:800;font-size:12px;box-shadow:0 4px 16px rgba(59,130,246,.45)}
.fab.hidden{display:none}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
.dot.on{background:#22c55e}.dot.off{background:#ef4444}
`;

  /* ---------------- 面板 ---------------- */
  let shadow, panel, body, fab;

  function buildPanel() {
    const host = document.createElement('div');
    host.setAttribute('data-aih-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483645';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    panel = h('div', { class: 'panel' });
    const hd = h('div', { class: 'hd' }, [
      h('div', { class: 'logo', text: 'AI' }),
      h('div', { class: 'ttl', text: '跨境售后话术助手' }),
      h('button', { class: 'btn sm', text: '—', title: '收起', onclick: () => setVisible(false) })
    ]);
    body = h('div', { class: 'bd' });
    const ft = h('div', { class: 'ft' }, [
      h('span', { class: 'dot off', id: 'st' }),
      h('span', { class: 'tiny', id: 'stt', text: '未连接' }),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn sm', text: '⚙', title: '重新拾取选择器', onclick: () => openPickerMenu() })
    ]);
    ft.querySelector('#st').id = 'st';
    ft.querySelector('#stt').id = 'stt';
    panel.appendChild(hd); panel.appendChild(body); panel.appendChild(ft);
    shadow.appendChild(panel);

    fab = h('button', { class: 'fab hidden', text: 'AI', title: '打开话术助手', onclick: () => setVisible(true) });
    shadow.appendChild(fab);
  }

  function setVisible(v) {
    state.visible = v;
    panel.classList.toggle('hidden', !v);
    fab.classList.toggle('hidden', v);
    // 把宿主页面往左挤，避免侧边栏盖住内容。
    // 纯 fixed 覆盖会挡住页面主体，坐席就没法一边看对话一边看话术了。
    try {
      const html = document.documentElement;
      if (v) {
        if (state._prevMargin === undefined) state._prevMargin = html.style.marginRight || '';
        html.style.transition = 'margin-right .18s ease';
        html.style.marginRight = PANEL_W + 'px';
        html.style.overflowX = 'hidden';
      } else {
        html.style.marginRight = state._prevMargin || '';
        html.style.overflowX = '';
      }
    } catch (e) { /* 个别页面可能不允许改根元素，忽略即可 */ }
  }

  function setStatus(ok, text) {
    if (!shadow) return;
    const d = shadow.querySelector('#st'), t = shadow.querySelector('#stt');
    if (d) d.className = 'dot ' + (ok ? 'on' : 'off');
    if (t) t.textContent = text;
  }

  let toastTimer = null;
  function toast(text, isErr) {
    if (!shadow) return;
    let el = shadow.querySelector('#toast');
    if (!el) {
      el = h('div', { id: 'toast' });
      el.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:2147483647;padding:9px 14px;border-radius:20px;font-size:12px;font-weight:700;transition:.2s;opacity:0';
      shadow.appendChild(el);
    }
    el.textContent = text;
    el.style.background = isErr ? '#ef4444' : '#22c55e';
    el.style.color = isErr ? '#fff' : '#04210f';
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }

  /* ---------------- 渲染 ---------------- */
  const COUNTRY_ZH = { UNKNOWN: '未知', ES: '西班牙', DE: '德国', FR: '法国', IT: '意大利', US: '美国', GB: '英国', NL: '荷兰', EU: '欧盟' };
  const ESC_ZH = { supervisor_required: '技能策略要求主管介入', critical_urgency: '紧急度极高', escalated_emotion: '情绪失控', high_value_dispute: '高价值纠纷', insufficient_knowledge: '知识库无依据', all_candidates_rejected: '全部候选被拦截', platform_risk: '平台/拒付风险', legal_risk: '法律风险', customer_request: '客户要求转人工', low_acceptance: '连续未采纳', degraded_pipeline: '链路降级' };
  const RISK_ZH = { chargeback_risk: '拒付风险', platform_intervention_risk: '平台介入风险', legal_risk: '法律风险', public_opinion_risk: '舆情风险', repeat_complaint: '重复投诉', minor_involved: '涉未成年人' };

  function renderIdle(msgHtml) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'empty', html: msgHtml || '还没有读取对话<br>点下面的「读取并生成话术」' }));
  }

  function render() {
    if (!shadow) return;
    body.innerHTML = '';
    try { renderInner(); }
    catch (err) {
      const m = (err && (err.stack || err.message)) || String(err);
      console.error('[售后助手] 渲染失败', err);
      body.appendChild(h('div', {
        class: 'banner err',
        html: '<b>渲染失败</b><br>' + esc(m).replace(/\n/g, '<br>')
      }));
      if (state.lastResult) {
        body.appendChild(h('div', { class: 'card' }, [
          h('div', { class: 'sec', text: '后端返回的原始字段' }),
          h('div', { class: 'tiny', text: Object.keys(state.lastResult).join('、') })
        ]));
      }
    }
  }

  function renderInner() {

    // 服务状态
    if (!state.serverOk) {
      body.appendChild(h('div', {
        class: 'banner err',
        html: '<b>连不上本地服务</b><br>' + esc(state.serverMsg || '') +
              '<br><br>请在项目目录运行：<br><code style="font-size:11px">111\\启动.bat</code>'
      }));
    }

    // 适配器
    const ad = state.adapter;
    body.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '当前平台' }),
      h('div', { class: 'kv' }, [h('span', { text: '适配器' }), h('span', { text: ad.name })]),
      h('div', { class: 'kv' }, [h('span', { text: '消息区识别' }), h('span', {
        text: state.selectors.messageList || state.selectors.messageItem ? '选择器命中' : '启发式自动识别'
      })]),
      h('div', { class: 'kv' }, [h('span', { text: '读取到' }), h('span', {
        text: state.messages.length + ' 条消息'
      })]),
      !ad.verified && (state.selectors.messageList || state.selectors.messageItem)
        ? h('div', { class: 'tiny', style: 'margin-top:6px;color:#fcd34d', text: '⚠ 本平台选择器未经验证，如识别不准请用 ⚙ 重新拾取' })
        : null
    ]));

    // 对话预览
    if (state.messages.length) {
      const preview = AIH.messagesToText(state.messages, 8);
      body.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'sec', text: '对话预览（最近 8 条）' }),
        h('div', { class: 'pv', text: preview })
      ]));
    }

    // 分析结果
    const r = state.lastResult;
    if (!r) { renderIdle(); return; }

    if (r.escalation && r.escalation.need_human) {
      body.appendChild(h('div', {
        class: 'banner err',
        html: '<b>⚠ 高风险案件</b>（' + esc(ESC_ZH[r.escalation.reason] || r.escalation.reason || '') + '）<br>回复前请核对下方政策依据，避免口径与该国法规或平台规则冲突。'
      }));
    }

    // 意图情绪
    const a = r.analysis;
    const c1 = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '意图 / 情绪 / 紧急度' })]);
    const pills = h('div');
    (a.intents || []).forEach(i => pills.appendChild(h('span', { class: 'pill i', text: i.label_zh + ' ' + Math.round(i.confidence * 100) + '%' })));
    c1.appendChild(pills);
    c1.appendChild(h('div', { class: 'kv' }, [h('span', { text: '情绪' }), h('span', { text: a.emotion.polarity + ' / 强度 ' + a.emotion.intensity })]));
    const urgColor = { low: '#22c55e', medium: '#3b82f6', high: '#f59e0b', critical: '#ef4444' }[a.urgency];
    c1.appendChild(h('div', { class: 'kv' }, [h('span', { text: '紧急度' }), h('span', { html: '<span style="color:' + urgColor + '">' + esc(a.urgency) + '</span>' })]));
    c1.appendChild(h('div', { class: 'kv' }, [h('span', { text: '客户国家' }), h('span', { text: COUNTRY_ZH[r.input.country] || r.input.country })]));
    c1.appendChild(h('div', { class: 'kv' }, [h('span', { text: '知识覆盖' }), h('span', { text: r.retrieval.coverage })]));
    if ((a.risk_flags || []).length) {
      const p = h('div', { style: 'margin-top:6px' });
      a.risk_flags.forEach(x => p.appendChild(h('span', { class: 'pill r', text: RISK_ZH[x] || x })));
      c1.appendChild(p);
    }
    body.appendChild(c1);

    // 工单路由 + SLA（技能驱动，来自 ecommerce-intent-routing）
    if (r.routing) {
      const cr = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '工单路由（技能驱动）' })]);
      cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: '分派组' }), h('span', { text: r.routing.group })]));
      cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: 'SLA' }), h('span', { text: r.routing.sla })]));
      if (r.routing.risk && r.routing.risk !== '—') {
        cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: '风险提示' }), h('span', { text: r.routing.risk })]));
      }
      body.appendChild(cr);
    }

    // 情绪安抚策略（技能驱动，来自 customer-reply-craft）
    if (r.calming) {
      const cc = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '情绪安抚策略（技能驱动）' })]);
      cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '情绪级别' }), h('span', { text: r.calming.level + ' / 5' })]));
      cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '处理方式' }), h('span', { text: r.calming.action })]));
      if (r.calming.forbidden && r.calming.forbidden !== '—') {
        cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '禁止' }), h('span', { html: '<span style="color:#fca5a5">' + esc(r.calming.forbidden) + '</span>' })]));
      }
      body.appendChild(cc);
    }

    // 政策依据（这是"符合当地政策"的核心体现，扩展之前完全没展示）
    const evs = (r.retrieval && r.retrieval.evidence) || [];
    if (evs.length) {
      const ce = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '政策依据（' + evs.length + ' 条）' })]);
      evs.forEach(function (e) {
        ce.appendChild(h('div', { class: 'ev' }, [
          h('div', { class: 'evt', text: e.title }),
          h('div', { class: 'evs', text: e.snippet }),
          h('div', { class: 'evm', text: e.doc_id + ' · ' + e.country + ' · 生效 ' + (e.effective_date || '-') + ' · 匹配 ' + e.score })
        ]));
      });
      body.appendChild(ce);
    } else if (r.retrieval) {
      body.appendChild(h('div', { class: 'banner warn', text: '未检索到可依据的政策条目 —— 此时不应给出任何政策承诺，请人工核实。' }));
    }

    // 技能命中（触发词机制）
    if (r.meta && r.meta.skills && r.meta.skills.length) {
      const cs = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '命中技能（' + r.meta.skills.length + '）' })]);
      const sp = h('div');
      r.meta.skills.forEach(function (n) { sp.appendChild(h('span', { class: 'pill t', text: n })); });
      cs.appendChild(sp);
      if (r.meta.composed_prompt_chars) {
        cs.appendChild(h('div', { class: 'tiny', text: '已注入提示词 ' + r.meta.composed_prompt_chars + ' 字符' }));
      }
      body.appendChild(cs);
    }

    // 候选话术
    const compMap = {};
    (r.compliance || []).forEach(c => compMap[c.candidate_id] = c);
    const recId = r.final.recommended_candidate_id;

    body.appendChild(h('div', { class: 'sec', style: 'margin:2px 0 7px', text: '候选话术（' + r.candidates.length + ' 条）' }));

    r.candidates.forEach(c => {
      const comp = compMap[c.candidate_id] || { decision: 'pass', violations: [] };
      const isRec = c.candidate_id === recId;
      const card = h('div', { class: 'cand' + (isRec ? ' rec' : '') + (comp.decision === 'reject' ? ' rej' : '') });

      const ch = h('div', { class: 'ch' }, [
        h('span', { class: 'tag st', text: c.style }),
        isRec ? h('span', { class: 'tag ok', text: '★ 推荐' }) : null,
        h('span', { class: 'tag ' + (comp.decision === 'pass' ? 'ok' : comp.decision === 'revise' ? 'rv' : 'rj'),
                    text: comp.decision === 'pass' ? '✓ 合规' : comp.decision === 'revise' ? '⚠ 需修订' : '✕ 已拦截' }),
        c.unsupported ? h('span', { class: 'tag rv', text: '无依据' }) : null
      ]);
      card.appendChild(ch);

      const target = pickTarget(c);
      card.appendChild(h('div', { class: 'cb', text: target }));
      card.appendChild(h('div', { class: 'cb zh', text: '中文：' + c.text_zh }));

      (comp.violations || []).forEach(v => {
        card.appendChild(h('div', {
          class: 'vio' + (v.severity === 'block' ? ' blk' : ''),
          html: '<b>[' + esc(v.rule_id) + ']</b> ' + esc(v.title || '') + '<br>命中：<b>' + esc(v.span) + '</b><br>' + esc(v.reason) + '<br>建议：' + esc(v.suggestion)
        }));
      });

      const cf = h('div', { class: 'cf' });
      if (comp.decision !== 'reject') {
        cf.appendChild(h('button', {
          class: 'btn sm pri', text: '⤵ 插入输入框',
          onclick: () => insertToInput(target)
        }));
        cf.appendChild(h('button', { class: 'btn sm', text: '📋 复制', onclick: () => copy(target) }));
        cf.appendChild(h('button', { class: 'btn sm', text: '✓ 采纳', onclick: () => fb('accept', c, r) }));
      } else {
        cf.appendChild(h('span', { class: 'tag rj', text: '违反合规规则，不可发送' }));
      }
      cf.appendChild(h('button', { class: 'btn sm', text: '✕', title: '忽略', onclick: () => fb('ignore', c, r) }));
      card.appendChild(cf);
      body.appendChild(card);
    });

    // 底部信息
    body.appendChild(h('div', { class: 'tiny', style: 'margin-top:4px', html:
      'trace ' + esc(r.trace_id) + ' · ' + r.meta.latency_ms + 'ms · 话术来源：' +
      (r.meta.generated_by === 'model' ? '模型' : '本地模板') +
      '<br>读取方式：' + (state.selectors.messageList || state.selectors.messageItem ? '适配器选择器' : '启发式识别') +
      ' · 消息 ' + state.messages.length + ' 条'
    }));
  }

  function pickTarget(c) {
    if (state.targetLang === 'zh') return c.text_zh;
    if (state.targetLang === 'es') return c.text_es || c.text_en || c.text_zh;
    return c.text_en || c.text_zh;
  }

  function renderFooter() {
    const ft = shadow.querySelector('.ft');
    ft.innerHTML = '';
    ft.appendChild(h('span', { class: 'dot ' + (state.serverOk ? 'on' : 'off') , id: 'st' }));
    ft.appendChild(h('span', { class: 'tiny', id: 'stt', text: state.serverOk ? '已连接' : '未连接' }));
    ft.appendChild(h('span', { style: 'flex:1' }));
    ft.appendChild(h('button', { class: 'btn sm', text: '⚙', title: '重新拾取选择器', onclick: openPickerMenu }));
  }

  /* ---------------- 动作 ---------------- */
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); toast('已复制');
    }
  }

  function insertToInput(text) {
    let box = null;
    if (state.selectors.inputBox) { try { box = AIH.$(state.selectors.inputBox); } catch (e) {} }
    if (!box) box = AIH.findInputBox();
    if (!box) { toast('没找到输入框，请用 ⚙ 拾取一次', true); return; }
    const ok = AIH.insertText(box, text);
    if (ok) toast('已插入输入框');
    else toast('插入失败，请手动粘贴', true);
  }

  async function fb(action, cand, res) {
    if (!res) return;
    await msg('feedback', {
      payload: {
        trace_id: res.trace_id, action: action, style: cand.style,
        candidate_id: cand.candidate_id, intent: res.analysis.primary_intent,
        country: res.input.country, final_text: cand.text_zh || ''
      }
    });
    toast('已记录：' + ({ accept: '采纳', ignore: '忽略', edit: '修改采纳' }[action] || action));
  }

  /* ---------------- 读取与分析 ---------------- */
  function readOnce() {
    const r = AIH.extractConversation({ selectors: state.selectors });
    state.messages = r.messages || [];
    return r;
  }

  async function analyze() {
    if (state.busy) return;
    const r = readOnce();
    if (!r.messages.length) {
      toast('没读到对话，请用 ⚙ 拾取消息区', true);
      render();
      return;
    }
    const text = AIH.messagesToText(state.messages, 20);
    if (text === state.lastText && state.lastResult) { render(); return; }

    state.busy = true;
    render();
    const res = await msg('analyze', {
      payload: { text: text, country: state.country, platform: state.platform, category: 'unknown' }
    });
    state.busy = false;

    if (!res || !res.ok) {
      state.serverOk = false;
      state.serverMsg = (res && res.error) || '未知错误';
      setStatus(false, '未连接');
      render();
      return;
    }
    state.serverOk = true;
    state.lastText = text;
    state.lastResult = res.data.result;
    setStatus(true, '已连接');
    render();
  }

  function startWatch() {
    if (state.watching) return;
    state.watching = true;
    // 定时兜底
    state.timer = setInterval(() => { if (!state.busy) analyze(); }, 3000);
    // DOM 变化即时触发（防抖）
    const deb = AIH.debounce(() => { if (!state.busy && state.watching) analyze(); }, 900);
    state.observer = new MutationObserver(deb);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    renderFooterButtons();
    toast('已开启自动监听');
  }

  function stopWatch() {
    state.watching = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    renderFooterButtons();
    toast('已停止监听');
  }

  function renderFooterButtons() {
    let bar = shadow.querySelector('#actbar');
    if (!bar) {
      bar = h('div', { id: 'actbar', class: 'card' });
      body.insertBefore(bar, body.firstChild);
    }
    bar.innerHTML = '';
    bar.appendChild(h('div', { class: 'sec', text: '操作' }));
    const row1 = h('div', { class: 'row' });
    row1.appendChild(h('button', { class: 'btn pri', text: '读取并生成话术', onclick: analyze }));
    row1.appendChild(state.watching
      ? h('button', { class: 'btn dan', text: '⏹ 停止监听', onclick: stopWatch })
      : h('button', { class: 'btn', text: '▶ 自动监听', onclick: startWatch }));
    row1.appendChild(h('button', { class: 'btn sm', text: '↻', title: '刷新读取', onclick: () => { state.lastText = ''; analyze(); } }));
    bar.appendChild(row1);

    const row2 = h('div', { class: 'row', style: 'margin-top:8px' });
    const cs = h('select', { class: 'sel', style: 'flex:1;min-width:110px', onchange: (e) => { state.country = e.target.value; state.lastText = ''; } });
    [['UNKNOWN', '国家：未知（保守）'], ['ES', '西班牙'], ['DE', '德国'], ['FR', '法国'], ['IT', '意大利'], ['US', '美国'], ['GB', '英国'], ['NL', '荷兰']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === state.country) o.selected = true; cs.appendChild(o); });
    row2.appendChild(cs);

    const ls = h('select', { class: 'sel', style: 'flex:1;min-width:96px', onchange: (e) => { state.targetLang = e.target.value; render(); } });
    [['en', '英文'], ['es', '西语'], ['zh', '中文']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === state.targetLang) o.selected = true; ls.appendChild(o); });
    row2.appendChild(ls);
    bar.appendChild(row2);

    if (state.busy) bar.appendChild(h('div', { class: 'tiny', style: 'margin-top:6px', text: '正在分析…' }));
  }

  /* ---------------- 选择器拾取 ---------------- */
  function openPickerMenu() {
    const items = [
      { key: 'messageList', label: '① 拾取「消息区」容器', mode: 'list',
        help: '点一下整个对话列表所在的区域（一大块包含很多条消息的容器）' },
      { key: 'inputBox', label: '② 拾取「回复输入框」', mode: 'input',
        help: '点一下你平时打字的那个输入框' }
    ];
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '重新拾取页面元素' }),
      h('div', { class: 'tiny', html: '平台改版后识别不准时，用这里重新教一遍。<br>拾取结果只保存在本机浏览器里。' })
    ]));
    items.forEach(it => {
      const card = h('div', { class: 'card' }, [
        h('div', { style: 'font-weight:600;margin-bottom:4px', text: it.label }),
        h('div', { class: 'tiny', text: it.help }),
        h('div', { class: 'row', style: 'margin-top:8px' }, [
          h('button', { class: 'btn pri sm', text: '开始拾取', onclick: () => beginPick(it) })
        ])
      ]);
      body.appendChild(card);
    });
    body.appendChild(h('div', { class: 'row' }, [
      h('button', { class: 'btn sm', text: '← 返回', onclick: render }),
      h('button', { class: 'btn sm dan', text: '清除本机已学选择器', onclick: clearOverrides })
    ]));
  }

  function beginPick(it) {
    toast('请在页面上点击目标元素（Esc 取消）');
    AIH.Picker.start(it.mode, async (res) => {
      if (!res || !res.ok) { toast('已取消'); render(); return; }
      state.overrides[it.key] = res.selector;
      await msg('config', { payload: { host: HOST, save: { [it.key]: res.selector } } });
      state.selectors = AIH.Adapters.resolveSelectors(state.adapter, state.overrides);
      toast('已记住：匹配 ' + res.count + ' 个元素');
      state.lastText = '';
      render();
    });
  }

  async function clearOverrides() {
    state.overrides = {};
    await msg('config', { payload: { host: HOST, save: { messageList: '', messageItem: '', inputBox: '' } } });
    state.selectors = AIH.Adapters.resolveSelectors(state.adapter, {});
    toast('已清除');
    render();
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    buildPanel();
    setVisible(true);
    try {
      await bootInner();
    } catch (err) {
      // 关键：任何初始化异常都要**显示出来**。
      // 之前异常会让面板一片空白 + 底部只写"未连接"，根本没法排查。
      const m = (err && (err.stack || err.message)) || String(err);
      console.error('[售后助手] 初始化失败', err);
      setStatus(false, '初始化失败');
      body.innerHTML = '';
      body.appendChild(h('div', {
        class: 'banner err',
        html: '<b>扩展初始化失败</b><br>' + esc(m).replace(/\n/g, '<br>') +
              '<br><br>请把这张截图反馈给开发者。'
      }));
      const info = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '环境信息' })]);
      info.appendChild(h('div', { class: 'kv' }, [h('span', { text: '页面' }), h('span', { text: location.hostname })]));
      info.appendChild(h('div', { class: 'kv' }, [h('span', { text: '协议' }), h('span', { text: location.protocol })]));
      info.appendChild(h('div', { class: 'kv' }, [h('span', { text: 'AIH 已加载' }), h('span', { text: String(!!window.AIH) })]));
      info.appendChild(h('div', { class: 'kv' }, [h('span', { text: '适配器' }), h('span', { text: state.adapter ? state.adapter.id : '(未识别)' })]));
      body.appendChild(info);
    }
  }

  async function bootInner() {

    state.adapter = AIH.Adapters.detect();
    // 平台默认值
    if (state.adapter.id === 'tiktok_shop') state.platform = 'tiktok_shop';
    if (state.adapter.id === 'amazon') state.platform = 'amazon';

    // 读取用户已学的选择器
    const cfg = await msg('config', { payload: { host: HOST } });
    if (cfg && cfg.ok && cfg.data) state.overrides = cfg.data;
    state.selectors = AIH.Adapters.resolveSelectors(state.adapter, state.overrides);

    // 健康检查
    const hp = await msg('health');
    state.serverOk = !!(hp && hp.ok);
    if (!state.serverOk) state.serverMsg = (hp && hp.error) || '';
    setStatus(state.serverOk, state.serverOk ? '已连接' : '未连接');

    render();
    renderFooterButtons();
    setVisible(true);

    // 首次自动读一次
    setTimeout(() => { if (state.serverOk) analyze(); }, 600);

    // 监听 URL 变化（SPA 路由切换）
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        state.adapter = AIH.Adapters.detect();
        state.selectors = AIH.Adapters.resolveSelectors(state.adapter, state.overrides);
        state.lastText = '';
        state.lastResult = null;
        setTimeout(() => analyze(), 1200);
      }
    }, 1500);

    // 用户改了设置就重算
    AIH.__panel = { toggle: () => setVisible(!state.visible) };
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'toggle') setVisible(!state.visible);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
