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
    lastError: '',
    serverMsg: '',
    // 模型配置界面（首次使用时要输入自己的 API Key，替代传统"登录"）
    setupMode: false,
    setupFirstRun: false,
    model: null,
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
  const SERVER_URL = 'http://127.0.0.1:8799';   // 与 background.js 的 SERVER 保持一致，界面上会显示出来便于排查
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
:host{all:initial;--panelw:392px;
  --bg:#f3f6fb;--card:#ffffff;--primary:#2f6bff;--primary-soft:#eaf0ff;
  --danger:#e5484d;--danger-soft:#fdebec;--warn:#b47207;--warn-soft:#fff6e6;
  --ok:#18a058;--ok-soft:#e8f7ef;--info-soft:#eef4ff;
  --text:#1f2329;--muted:#8a919f;--border:#e3e8f3;--radius:14px}
*{box-sizing:border-box;font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.panel{position:fixed;top:0;right:0;width:var(--panelw);height:100vh;background:var(--bg);color:var(--text);
  border-left:1px solid var(--border);display:flex;flex-direction:column;z-index:2147483645;
  box-shadow:-4px 0 20px rgba(31,35,41,.08);font-size:13px;line-height:1.6}
.panel.hidden{display:none}
.hd{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--border);
  background:linear-gradient(90deg,#1c2b4a,#27407a);color:#fff;flex:0 0 auto}
.logo{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.16);
  display:grid;place-items:center;font-weight:800;font-size:11px;color:#fff;flex:0 0 auto;
  border:1px solid rgba(255,255,255,.28)}
.ttl{font-weight:700;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff}
.hd .btn{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);color:#fff}
.hd .btn:hover{background:rgba(255,255,255,.26);color:#fff}
.bd{flex:1 1 auto;overflow-y:auto;padding:12px}
.bd::-webkit-scrollbar{width:8px}.bd::-webkit-scrollbar-thumb{background:#cfd8e8;border-radius:4px}
.ft{flex:0 0 auto;padding:9px 12px;border-top:1px solid var(--border);background:var(--card);display:flex;gap:6px;align-items:center}
.btn{border:1px solid var(--border);background:var(--card);color:var(--text);padding:6px 12px;border-radius:9px;
  cursor:pointer;font-size:12.5px;font-family:inherit;transition:all .15s ease;white-space:nowrap}
.btn:hover{border-color:var(--primary);color:var(--primary)}
.btn.pri{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
.btn.pri:hover{background:#2456d6;color:#fff}
.btn.dan{background:var(--danger-soft);border-color:#f3b9bb;color:var(--danger)}
.btn.dan:hover{background:#fbdcdd;color:var(--danger)}
.btn.sm{padding:4px 9px;font-size:11.5px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.sel{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px;width:100%}
.sel:focus{outline:none;border-color:var(--primary)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:13px;margin-bottom:11px}
.sec{font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.03em;margin-bottom:8px}
.banner{padding:10px 12px;border-radius:10px;font-size:12px;margin-bottom:11px;line-height:1.65}
.banner.err{background:var(--danger-soft);border:1px solid #f3b9bb;color:#a3282c}
.banner.ok{background:var(--ok-soft);border:1px solid #b4e2c8;color:#0f6b3a}
.banner.warn{background:var(--warn-soft);border:1px solid #f0d9a8;color:#8a5706}
.kv{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:12px;border-bottom:1px solid #f0f3f9}
.kv:last-child{border-bottom:none}
.kv span:first-child{color:var(--muted);flex:0 0 auto}
.kv span:last-child{text-align:right;font-weight:600;word-break:break-all}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;margin:0 4px 4px 0;font-weight:600}
.pill.i{background:var(--primary-soft);color:#2456d6}
.pill.r{background:var(--danger-soft);color:var(--danger)}
.pill.s{background:#f1ecff;color:#6b46c1}
.pill.t{background:var(--ok-soft);color:#0f6b3a}
.cand{border:1px solid var(--border);border-radius:11px;background:var(--card);margin-bottom:10px;overflow:hidden}
.cand.rec{border-color:#8fd3ae;box-shadow:0 0 0 2px var(--ok-soft)}
.cand.rej{opacity:.55;border-color:#f3b9bb}
.ch{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;font-size:11px}
.tag{padding:2px 8px;border-radius:6px;background:#f0f3f9;color:#556070}
.tag.st{background:#f1ecff;color:#6b46c1}
.tag.ok{background:var(--ok-soft);color:#0f6b3a}
.tag.rv{background:var(--warn-soft);color:var(--warn)}
.tag.rj{background:var(--danger-soft);color:var(--danger)}
.cb{padding:10px 11px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.cb.zh{border-top:1px dashed var(--border);color:#5b6472;font-size:11.5px;background:#fafbfe}
.cf{display:flex;gap:5px;padding:8px 10px;border-top:1px solid var(--border);flex-wrap:wrap;align-items:center;background:#fafbfe}
.vio{margin:0 10px 9px;padding:8px 10px;border-radius:8px;background:var(--warn-soft);
  border-left:3px solid #f0a020;font-size:11.5px;line-height:1.6;color:#8a5706}
.vio.blk{background:var(--danger-soft);border-left-color:var(--danger);color:#a3282c}
.tiny{font-size:11px;color:var(--muted);line-height:1.6}
.empty{text-align:center;padding:30px 14px;color:var(--muted);font-size:12px;line-height:1.9}
/* 政策依据 */
.ev{background:#fafbfe;border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:8px}
.ev .evt{font-weight:600;font-size:12px;color:var(--text);margin-bottom:3px}
.ev .evs{font-size:11.5px;color:#5b6472;line-height:1.65}
.ev .evm{font-size:10px;color:var(--muted);margin-top:5px}
.pv{max-height:96px;overflow-y:auto;background:#fafbfe;border:1px solid var(--border);border-radius:9px;
  padding:8px 9px;font-size:11.5px;color:#5b6472;white-space:pre-wrap;line-height:1.6}
.fab{position:fixed;right:16px;bottom:16px;width:46px;height:46px;border-radius:50%;z-index:2147483645;
  background:var(--primary);color:#fff;border:none;cursor:pointer;
  font-weight:800;font-size:12px;box-shadow:0 6px 18px rgba(47,107,255,.4)}
.fab.hidden{display:none}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
.dot.on{background:var(--ok)}.dot.off{background:var(--danger)}
/* ---------- 首次配置：输入自己的 API Key（替代原项目的登录界面） ---------- */
.setup{padding:2px}
.setup-hero{text-align:center;padding:14px 0 14px}
.setup-hero .big{font-size:36px;line-height:1}
.setup-hero h3{margin:12px 0 5px;font-size:15px;color:var(--text)}
.setup-hero p{margin:0;font-size:11.5px;color:var(--muted);line-height:1.75}
.fld{display:block;margin-bottom:12px}
.fld .lb{display:block;font-size:11.5px;color:#5b6472;margin-bottom:5px;font-weight:600}
.fld input{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:9px;font-size:12.5px;
  font-family:inherit;background:var(--card);color:var(--text)}
.fld input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)}
.fld .hint{font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.6}
.steps{counter-reset:s;padding:0;margin:0;list-style:none}
.steps li{position:relative;padding:0 0 9px 20px;font-size:11.5px;color:#5b6472;line-height:1.65}
.steps li:before{counter-increment:s;content:counter(s);position:absolute;left:0;top:1px;
  width:14px;height:14px;border-radius:50%;background:var(--primary-soft);color:#2456d6;
  font-size:9px;font-weight:700;display:grid;place-items:center}
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
      h('button', { class: 'btn sm', text: '🔑', title: '模型 / API Key 设置',
        onclick: () => { state.setupMode = true; state.setupFirstRun = false; render(); } }),
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
    // ⚠️ 这里**不能**写 body.innerHTML = ''。
    //    那会把上面刚加的"连不上本地服务"横幅和适配器信息一起擦掉，
    //    用户只看到一个空面板，根本没法排查（v0.9 踩过这个坑）。
    const prev = body.querySelector ? body.querySelector('.idlebox') : null;
    if (prev && prev.remove) prev.remove();
    body.appendChild(h('div', { class: 'empty idlebox', html: msgHtml || '还没有读取对话<br>点下面的「读取并生成话术」' }));
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

  /* ---------------- 模型配置界面（替代传统"登录"） ----------------
     设计意图：别人拿到这个扩展，像用 Codex / DSH 一样填入自己的
     百度千帆 API Key 就能用，不需要我们发账号，也不需要任何登录。
     Key 走本地服务 DPAPI 加密保存，界面上永不回显。 */
  function renderSetup() {
    body.innerHTML = '';
    const box = h('div', { class: 'setup' });
    const m = state.model || {};
    const first = state.setupFirstRun;

    const hero = h('div', { class: 'setup-hero' });
    hero.appendChild(h('div', { class: 'big', text: '🧵' }));
    hero.appendChild(h('h3', { text: first ? '配置你的 API Key' : '模型设置' }));
    hero.appendChild(h('p', {
      html: first
        ? '填入你自己的百度千帆 API Key 即可开始使用。<br>Key 用 Windows DPAPI 加密后只存本机，<b>不上传、不回显</b>。'
        : '修改后立即生效。API Key 留空表示不改动。'
    }));
    box.appendChild(hero);

    // 当前状态
    const sc = h('div', { class: 'card' });
    sc.appendChild(h('div', { class: 'sec', text: '当前状态' }));
    sc.appendChild(h('div', { class: 'kv' }, [
      h('span', { text: 'API Key' }),
      h('span', { html: m.has_key
        ? '<span style="color:var(--ok)">已配置</span>'
        : '<span style="color:var(--warn)">未配置</span>' })
    ]));
    if (m.has_key && m.key_fingerprint) {
      sc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '指纹' }), h('span', { text: m.key_fingerprint })]));
    }
    sc.appendChild(h('div', { class: 'kv' }, [
      h('span', { text: '生效模式' }),
      h('span', { text: m.mode === 'model' ? '外部大模型' : '本地规则引擎' })
    ]));
    box.appendChild(sc);

    // 表单
    const fc = h('div', { class: 'card' });
    fc.appendChild(h('div', { class: 'sec', text: first ? '填入 API Key' : '修改配置' }));

    const ki = h('input', { type: 'password', autocomplete: 'off',
      placeholder: m.has_key ? '已配置（留空则不改动）' : '粘贴你的 API Key' });
    const kf = h('label', { class: 'fld' });
    kf.appendChild(h('span', { class: 'lb', text: '百度千帆 API Key' }));
    kf.appendChild(ki);
    kf.appendChild(h('div', { class: 'hint', html:
      '控制台 → 千帆 ModelBuilder → 模型服务 → API Key。' +
      '<span id="setupToggle" style="color:var(--primary);cursor:pointer">显示明文</span>' }));
    fc.appendChild(kf);

    const mi = h('input', { type: 'text', placeholder: 'ernie-4.0-8k-latest' });
    mi.value = m.model || '';
    const mf = h('label', { class: 'fld' });
    mf.appendChild(h('span', { class: 'lb', text: '模型名' }));
    mf.appendChild(mi);
    fc.appendChild(mf);

    const ei = h('input', { type: 'text', placeholder: 'https://qianfan.baidubce.com/v2' });
    ei.value = m.endpoint || '';
    const ef = h('label', { class: 'fld' });
    ef.appendChild(h('span', { class: 'lb', text: '接口地址（一般不用改）' }));
    ef.appendChild(ei);
    fc.appendChild(ef);

    const btn = h('button', { class: 'btn pri', text: first ? '保存并开始使用' : '保存' });
    const msgEl = h('div', { class: 'tiny', style: 'margin-top:9px' });
    btn.onclick = () => saveConfig(ki, mi, ei, btn, msgEl);

    const row = h('div', { class: 'row' }, [btn]);
    if (!first) {
      const back = h('button', { class: 'btn', text: '返回' });
      back.onclick = () => { state.setupMode = false; render(); renderFooterButtons(); };
      row.appendChild(back);
      const clr = h('button', { class: 'btn dan', text: '清除 Key' });
      clr.onclick = async () => {
        clr.disabled = true;
        const r = await msg('config-save', { api_key: '' });
        clr.disabled = false;
        if (r && r.ok) { state.model = (r.data && r.data.model) || null; toast('已清除 API Key'); renderSetup(); }
        else { toast('清除失败', false); }
      };
      row.appendChild(clr);
    }
    fc.appendChild(row);
    fc.appendChild(msgEl);
    box.appendChild(fc);

    if (first) {
      const ul = h('ul', { class: 'steps' });
      ['登录百度智能云控制台',
       '进入「千帆 ModelBuilder」→「模型服务」→「API Key」',
       '新建或复制一个 API Key（形如 bce-v3-...）',
       '粘贴到上面，点「保存并开始使用」'
      ].forEach(function (t) { ul.appendChild(h('li', { text: t })); });
      const tips = h('div', { class: 'card' });
      tips.appendChild(h('div', { class: 'sec', text: '怎么拿到 API Key' }));
      tips.appendChild(ul);
      tips.appendChild(h('div', { class: 'tiny', html:
        '没有 Key 也能用：系统会走本地规则引擎出话术，只是不调用大模型。<br>' +
        '随时可从底部 <b>🔑</b> 按钮回到这里配置。' }));
      box.appendChild(tips);
    }

    body.appendChild(box);

    const tg = box.querySelector('#setupToggle');
    if (tg) {
      tg.onclick = function () {
        const show = ki.type === 'password';
        ki.type = show ? 'text' : 'password';
        tg.textContent = show ? '隐藏' : '显示明文';
      };
    }
  }

  async function saveConfig(ki, mi, ei, btn, msgEl) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '保存中…';
    msgEl.textContent = '';

    const payload = { provider: 'qianfan' };
    if (ki.value.trim()) payload.api_key  = ki.value.trim();
    if (mi.value.trim()) payload.model    = mi.value.trim();
    if (ei.value.trim()) payload.endpoint = ei.value.trim();

    const res = await msg('config-save', payload);
    btn.disabled = false;
    btn.textContent = old;

    if (!res || !res.ok) {
      msgEl.innerHTML = '<span style="color:var(--danger)">保存失败：' +
        esc((res && res.error) || '未知错误') + '</span>';
      return;
    }
    state.model = (res.data && res.data.model) || state.model;
    ki.value = '';   // 关键：保存后立刻清空输入框，不在界面上留着密钥
    msgEl.innerHTML = '<span style="color:var(--ok)">✓ ' +
      esc(((res.data && res.data.changed) || []).join('，') || '已保存') + '</span>';

    if (state.setupFirstRun) {
      state.setupFirstRun = false;
      state.setupMode = false;
      render();
      renderFooterButtons();
      toast('配置完成，开始使用');
      setTimeout(() => { if (state.serverOk) analyze(); }, 300);
    } else {
      renderSetup();
    }
  }

  function renderInner() {
    // 模型未配置（或用户主动打开设置）→ 进配置界面。
    // 这就是传统"登录界面"的替代：没有账号密码，只有自己的 API Key。
    if (state.setupMode) { renderSetup(); return; }

    // 服务状态：把**完整错误**原样打出来，不要藏起来
    if (!state.serverOk) {
      const ban = h('div', { class: 'banner err' });
      ban.appendChild(h('div', {
        html: '<b>连不上本地服务</b><br>' +
              '<code style="font-size:10.5px;background:#0a0d12;padding:2px 5px;border-radius:3px">' +
              esc(SERVER_URL) + '/api/health</code><br>' +
              '<span style="color:#fecaca;font-size:11px">' + esc(state.serverMsg || '(没有拿到错误信息)') + '</span>' +
              '<br><br>请确认已在项目目录运行：<br><code style="font-size:10.5px">111\\启动.bat</code>'
      }));
      const btnRetry = h('button', { class: 'btn sm', text: '↻ 重试连接' });
      btnRetry.onclick = async () => {
        btnRetry.textContent = '连接中…'; btnRetry.disabled = true;
        const hp = await msg('health');
        state.serverOk = !!(hp && hp.ok);
        state.serverMsg = state.serverOk ? '' : ((hp && hp.error) || '未知错误');
        setStatus(state.serverOk, state.serverOk ? '已连接' : '未连接');
        render();
      };
      ban.appendChild(h('div', { style: 'margin-top:9px' }, [btnRetry]));
      body.appendChild(ban);
    } else {
      body.appendChild(h('div', { class: 'banner ok', text: '✓ 已连接本地服务 ' + SERVER_URL }));
    }

    // 上一次请求失败（连接是好的，只是这次调用出错）—— 必须和"未连接"区分开
    if (state.lastError) {
      const eb = h('div', { class: 'banner warn' });
      eb.appendChild(h('div', { html: '<b>上次请求失败</b>（服务连接正常）' }));
      eb.appendChild(h('div', {
        style: 'margin-top:5px;font-size:11px;white-space:pre-wrap;word-break:break-word',
        text: state.lastError
      }));
      const btnClr = h('button', { class: 'btn sm ghost', text: '知道了' });
      btnClr.onclick = () => { state.lastError = ''; render(); };
      eb.appendChild(h('div', { style: 'margin-top:8px' }, [btnClr]));
      body.appendChild(eb);
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
      trace_id: res.trace_id, action: action, style: cand.style,
      candidate_id: cand.candidate_id, intent: res.analysis.primary_intent,
      country: res.input.country, final_text: cand.text_zh || ''
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
    // 发送前先自检：文本为空就别浪费一次请求（服务端会回 400 "text 不能为空"）
    if (!text || !text.trim()) {
      state.lastError = '提取到的对话文本为空（识别到 ' + state.messages.length +
        ' 个元素但没有可读文字）。请用底部 ⚙ 重新拾取消息区。';
      toast('没读到有效文字，请拾取消息区', false);
      render();
      return;
    }
    if (text === state.lastText && state.lastResult) { render(); return; }

    state.busy = true;
    render();
    const res = await msg('analyze', { text: text, country: state.country, platform: state.platform, category: 'unknown' });
    state.busy = false;

    if (!res || !res.ok) {
      // ⚠️ 这里**绝对不能**把 serverOk 改成 false。
      //    /api/health 可能一直是通的，这只是"这一次 analyze 失败了"。
      //    之前这么写导致界面把请求失败误报成"未连接"，排查绕了一大圈。
      state.lastError = (res && res.error) || '未知错误';
      toast('生成失败（连接正常）', false);
      render();
      return;
    }
    state.lastError = '';
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
      await msg('config', { host: HOST, save: { [it.key]: res.selector } });
      state.selectors = AIH.Adapters.resolveSelectors(state.adapter, state.overrides);
      toast('已记住：匹配 ' + res.count + ' 个元素');
      state.lastText = '';
      render();
    });
  }

  async function clearOverrides() {
    state.overrides = {};
    await msg('config', { host: HOST, save: { messageList: '', messageItem: '', inputBox: '' } });
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
    // 模块完整性自检。
    // 背景：content script 的所有文件共享同一全局作用域，任何文件顶层出现
    // 重复的 const/let 声明都会让**该文件及其后所有文件**整体不执行。
    // 那样 AIH 存在但 AIH.Adapters 是 undefined，后面会抛难以理解的 TypeError。
    // 这里提前拦住，并把"已加载了哪些字段"打出来，一眼能看出是哪个文件没跑。
    if (!AIH || !AIH.Adapters || typeof AIH.Adapters.detect !== 'function') {
      throw new Error(
        '模块未加载完整：AIH.Adapters 缺失。' +
        '常见原因是某个 content script 文件解析失败（跨文件重复声明 const/let）。' +
        ' 当前 AIH 已有字段：' + (AIH ? Object.keys(AIH).join(', ') || '(空)' : '(AIH 本身不存在)') +
        '。可运行 tools/test-extension-load.js 定位。'
      );
    }

    state.adapter = AIH.Adapters.detect();
    // 平台默认值
    if (state.adapter.id === 'tiktok_shop') state.platform = 'tiktok_shop';
    if (state.adapter.id === 'amazon') state.platform = 'amazon';

    // 读取用户已学的选择器
    const cfg = await msg('config', { host: HOST });
    if (cfg && cfg.ok && cfg.data) state.overrides = cfg.data;
    state.selectors = AIH.Adapters.resolveSelectors(state.adapter, state.overrides);

    // 健康检查
    const hp = await msg('health');
    state.serverOk = !!(hp && hp.ok);
    if (!state.serverOk) state.serverMsg = (hp && hp.error) || '';
    if (state.serverOk && hp.data) state.model = hp.data.model || null;
    setStatus(state.serverOk, state.serverOk ? '已连接' : '未连接');

    // 没配 API Key → 视为首次使用，直接进配置界面（替代登录）。
    // 不强制：用户也可以关掉它用本地规则引擎，所以只提示不阻断。
    if (state.serverOk && state.model && !state.model.has_key) {
      state.setupMode = true;
      state.setupFirstRun = true;
    }

    render();
    renderFooterButtons();
    setVisible(true);

    // 首次自动读一次（配置界面下不需要）
    setTimeout(() => { if (state.serverOk && !state.setupMode) analyze(); }, 600);

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
