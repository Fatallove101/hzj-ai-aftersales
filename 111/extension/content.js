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
    lastSource: '',
    readNote: '',
    src: 'dom',
    folds: {},
    ocrInfo: null,
    uiMode: 'dock',        // dock=挤开页面  float=悬浮可拖动
    uiSize: 'normal',
    pos: { x: -1, y: -1 },
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

  /* ---------------- 悬浮小窗：三档尺寸 + 位置记忆 ----------------
     尺寸与位置按【站点】分别记忆：客服后台和别的网站的合适位置不一样。 */
  const SIZES = {
    mini:   { w: 330, h: 430, label: '迷你' },
    normal: { w: 392, h: 720, label: '标准' },
    max:    { w: 600, h: 0,   label: '最大' }   // h=0 → 撑满窗口高度
  };

  function loadUiPrefs(cb) {
    try {
      chrome.storage.local.get(UI_KEY, function (r) {
        const v = r && r[UI_KEY];
        if (v) {
          if (v.mode === 'float' || v.mode === 'dock') state.uiMode = v.mode;
          if (SIZES[v.size]) state.uiSize = v.size;
          if (typeof v.x === 'number' && typeof v.y === 'number') { state.pos.x = v.x; state.pos.y = v.y; }
        }
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  function saveUiPrefs() {
    try {
      const o = {};
      o[UI_KEY] = { mode: state.uiMode, size: state.uiSize, x: state.pos.x, y: state.pos.y };
      chrome.storage.local.set(o);
    } catch (e) { }
  }

  // 把当前 uiMode / uiSize / pos 应用到面板上
  function applyUi() {
    if (!panel) return;
    const sz = SIZES[state.uiSize] || SIZES.normal;
    const html = document.documentElement;
    if (state.uiMode === 'float') {
      panel.classList.add('float');
      panel.style.width = sz.w + 'px';
      panel.style.height = (sz.h ? sz.h : Math.max(320, window.innerHeight - 40)) + 'px';
      if (state.pos.x < 0) state.pos.x = Math.max(8, window.innerWidth - sz.w - 24);
      if (state.pos.y < 0) state.pos.y = 12;
      const maxX = Math.max(8, window.innerWidth - sz.w - 8);
      const maxY = Math.max(8, window.innerHeight - 120);
      state.pos.x = Math.min(state.pos.x, maxX);
      state.pos.y = Math.min(state.pos.y, maxY);
      panel.style.left = state.pos.x + 'px';
      panel.style.top = state.pos.y + 'px';
      // 悬浮模式不挤页面
      if (state._prevMargin === undefined) state._prevMargin = html.style.marginRight || '';
      html.style.marginRight = state._prevMargin || '';
      html.style.overflowX = '';
    } else {
      panel.classList.remove('float');
      panel.style.left = ''; panel.style.top = '';
      panel.style.width = ''; panel.style.height = '';
      if (state.visible) {
        if (state._prevMargin === undefined) state._prevMargin = html.style.marginRight || '';
        html.style.transition = 'margin-right .18s ease';
        html.style.marginRight = PANEL_W + 'px';
        html.style.overflowX = 'hidden';
      }
    }
    // 同步按钮选中态
    if (shadow) {
      shadow.querySelectorAll('[data-size]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-size') === state.uiSize);
      });
    }
  }

  function setUiMode(mode) {
    state.uiMode = mode;
    if (mode === 'float' && !state.pos) state.pos = { x: -1, y: -1 };
    if (mode === 'float' && (state.pos.x < 0 || state.pos.y < 0)) {
      const sz = SIZES[state.uiSize] || SIZES.normal;
      state.pos.x = Math.max(8, window.innerWidth - sz.w - 24);
      state.pos.y = 12;
    }
    applyUi(); saveUiPrefs();
  }

  function setUiSize(name) {
    if (!SIZES[name]) return;
    state.uiSize = name;
    applyUi(); saveUiPrefs();
  }

  // 拖动标题栏移动小窗（仅悬浮模式）
  function makeDraggable(handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', function (e) {
      if (state.uiMode !== 'float') return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
    function onMove(e) {
      if (!dragging) return;
      const sz = SIZES[state.uiSize] || SIZES.normal;
      let nx = ox + (e.clientX - sx);
      let ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - Math.min(sz.w, window.innerWidth) - 4));
      ny = Math.max(0, Math.min(ny, window.innerHeight - 60));
      state.pos.x = nx; state.pos.y = ny;
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      saveUiPrefs();
    }
  }
  const SERVER_URL = 'http://127.0.0.1:8799';   // 与 background.js 的 SERVER 保持一致，界面上会显示出来便于排查
  const HOST = location.hostname;
  const STORE_KEY = 'site:' + HOST;
  const UI_KEY = 'ui:' + HOST;   // 必须放在 HOST 之后（TDZ：const 不提升）

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
/* ---------- 悬浮小窗模式（可拖动 + 三档缩放）----------
   停靠模式会把页面挤开，适合长时段盯单；
   悬浮模式不占页面布局，适合临时查一下、跟别的窗口并排。
   两种都要有：前者不遮挡内容，后者不打断布局。 */
.panel.float{left:0;top:0;right:auto;height:auto;border-radius:var(--radius);border:1px solid var(--border);
  box-shadow:0 12px 40px rgba(31,35,41,.22);overflow:hidden}
.panel.float .hd{cursor:move}
.panel.float .hd:active{cursor:grabbing}
.szbtns{display:flex;gap:3px;flex:0 0 auto}
.panel:not(.float) .szbtns{display:none}   /* 停靠模式没有尺寸概念 */
.panel:not(.float) .hd{cursor:default}
.szbtns .btn{padding:3px 7px;font-size:11px}
.szbtns .btn.on{background:rgba(255,255,255,.3);border-color:rgba(255,255,255,.5)}
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
/* ---------- 可折叠区块 ----------
   为什么默认收起：面板里除了"候选话术"，其余都是辅助信息。
   全部摊开会把核心产出挤到屏幕外，新人根本找不到该点什么。 */
.fold{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  margin-bottom:10px;overflow:hidden}
.foldhd{display:flex;align-items:center;gap:7px;padding:10px 12px;cursor:pointer;user-select:none}
.foldhd:hover{background:#fafbfe}
.foldchev{font-size:9px;color:var(--muted);width:11px;flex:0 0 auto;transition:transform .15s}
.foldttl{font-size:12px;font-weight:600;flex:1;min-width:0}
.foldbd{padding:0 13px 12px}
.fold.closed .foldbd{display:none}
.fold .foldhd .pill{margin:0}
/* ---------- 读取源按钮排 ---------- */
.srcbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}
.srcbtn{flex:1 1 auto;min-width:58px;padding:7px 4px;border:1px solid var(--border);background:var(--card);
  border-radius:9px;font-size:11.5px;cursor:pointer;font-family:inherit;color:var(--text);
  text-align:center;transition:all .15s;white-space:nowrap}
.srcbtn:hover{border-color:var(--primary);color:var(--primary)}
.srcbtn.on{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
.srcbtn:disabled{opacity:.45;cursor:not-allowed}
.winpick{max-height:190px;overflow-y:auto}
.winpick .winrow{padding:7px 9px;border:1px solid var(--border);border-radius:8px;margin-bottom:5px;
  cursor:pointer;font-size:11.5px;line-height:1.5}
.winpick .winrow:hover{border-color:var(--primary);background:#fafbfe}
.winpick .winrow .wt{font-weight:600}
.winpick .winrow .wp{color:var(--muted);font-size:10.5px}
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
    // 标题栏：停靠模式下当普通标题，悬浮模式下当拖动把手
    const szWrap = h('div', { class: 'szbtns' });
    ['mini', 'normal', 'max'].forEach(function (k) {
      szWrap.appendChild(h('button', {
        class: 'btn sm', 'data-size': k, text: SIZES[k].label,
        title: SIZES[k].label + '（' + SIZES[k].w + 'px 宽）',
        onclick: () => setUiSize(k)
      }));
    });
    const btnMode = h('button', {
      class: 'btn sm', text: '⇱', title: '切换「悬浮小窗 / 停靠侧栏」',
      onclick: () => {
        setUiMode(state.uiMode === 'float' ? 'dock' : 'float');
        toast(state.uiMode === 'float' ? '已切换为悬浮小窗（可拖动）' : '已切换为侧栏（挤开页面）');
      }
    });
    const hd = h('div', { class: 'hd' }, [
      h('div', { class: 'logo', text: 'AI' }),
      h('div', { class: 'ttl', text: '跨境售后话术助手' }),
      szWrap, btnMode,
      h('button', { class: 'btn sm', text: '—', title: '收起', onclick: () => setVisible(false) })
    ]);
    makeDraggable(hd);
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
    // 停靠模式把页面往左挤（避免遮挡）；悬浮模式不占页面布局。
    // 两种模式的差异都收在 applyUi 里，这里只负责还原。
    try {
      const html = document.documentElement;
      if (v) {
        applyUi();
      } else {
        html.style.marginRight = state._prevMargin || '';
        html.style.overflowX = '';
      }
    } catch (e) { /* 个别页面不允许改根元素，忽略 */ }
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

  /* ---------------- 可折叠区块 ----------------
     除候选话术外的所有卡片都收进折叠区，默认收起，状态按站点记忆。 */
  function fold(id, title, nodes, opts) {
    opts = opts || {};
    const open = !!state.folds[id];
    const c = h('div', { class: 'fold' + (open ? '' : ' closed') });
    const hd = h('div', { class: 'foldhd' });
    hd.appendChild(h('span', { class: 'foldchev', text: '▶' }));
    hd.appendChild(h('span', { class: 'foldttl', text: title }));
    if (opts.badge) hd.appendChild(h('span', { class: 'pill ' + (opts.badgeKind || 'i'), text: opts.badge }));
    const bd = h('div', { class: 'foldbd' });
    (nodes || []).forEach(function (n) { if (n) bd.appendChild(n); });
    c.appendChild(hd); c.appendChild(bd);
    hd.onclick = function () {
      const closed = c.classList.toggle('closed');
      state.folds[id] = !closed;
      saveFolds();
    };
    // 打开时把箭头转过来
    const ch = hd.firstChild;
    if (open) ch.style.transform = 'rotate(90deg)';
    const origToggle = hd.onclick;
    hd.onclick = function () { origToggle(); ch.style.transform = c.classList.contains('closed') ? '' : 'rotate(90deg)'; };
    return c;
  }

  /* 把渲染出来的辅助卡片转成可折叠，默认收起。
     用后处理而不是改七处卡片构造代码 —— 改动面小、不易漏。
     注意：候选话术不是 .card（直接挂 body），所以天然不受影响，始终展开。 */
  function makeCollapsible(card) {
    if (!card || !card.classList || card.classList.contains('fold')) return;
    const sec = card.querySelector('.sec');
    if (!sec) return;
    const title = String(sec.textContent || '').trim();
    if (!title) return;
    const id = 'sec:' + title.replace(/\s+/g, '');
    const rest = Array.prototype.slice.call(card.children).filter(function (c) { return c !== sec; });
    if (!rest.length) return;

    card.innerHTML = '';
    card.classList.add('fold');
    const hd = h('div', { class: 'foldhd' });
    const ch = h('span', { class: 'foldchev', text: '▶' });
    hd.appendChild(ch);
    hd.appendChild(h('span', { class: 'foldttl', text: title }));
    const bd = h('div', { class: 'foldbd' });
    rest.forEach(function (n) { bd.appendChild(n); });
    card.appendChild(hd); card.appendChild(bd);

    if (state.folds[id]) { ch.style.transform = 'rotate(90deg)'; }
    else { card.classList.add('closed'); }

    hd.onclick = function () {
      const closed = card.classList.toggle('closed');
      state.folds[id] = !closed;
      ch.style.transform = closed ? '' : 'rotate(90deg)';
      saveFolds();
    };
  }

  function applyFolds() {
    if (!body) return;
    const folded = [];
    Array.prototype.slice.call(body.querySelectorAll('.card')).forEach(function (c) {
      if (c.getAttribute('data-nofold') === '1') return;
      makeCollapsible(c);
      folded.push(c);
    });
    // 辅助信息统一挪到候选话术之后。
    // 核心产出（话术）应该紧跟在操作条下面 —— 新人打开面板第一眼要看到的就是它，
    // 而不是"当前平台/意图情绪"这些诊断信息。
    folded.forEach(function (c) { body.appendChild(c); });
  }

  function saveFolds() {
    try { const o = {}; o['folds:' + HOST] = state.folds; chrome.storage.local.set(o); } catch (e) { }
  }
  function loadFolds(cb) {
    try {
      chrome.storage.local.get('folds:' + HOST, function (r) {
        const v = r && r['folds:' + HOST];
        if (v) state.folds = v;
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  /* ---------------- 读取源 ----------------
     扩展一共 5 种读法。这里把「服务端已实现」的四种接出来，
     避免扩展重复实现一套。 */
  const READ_SOURCES = [
    { id: 'dom',  label: '页面',   title: '直读页面上的对话元素（最准，推荐）' },
    { id: 'clip', label: '剪贴板', title: '读系统剪贴板 —— 在任何软件里选中文字按 Ctrl+C，再点这里' },
    { id: 'win',  label: '窗口',   title: '直读本机某个窗口的文字（桌面客户端用，不走 OCR 无误差）' },
    { id: 'ocr',  label: '读屏',   title: '截当前标签页做 OCR（DOM 读不到时用）' }
  ];

  function renderSourceBar() {
    const bar = h('div', { class: 'srcbar' });
    READ_SOURCES.forEach(function (s) {
      const b = h('button', {
        class: 'srcbtn' + (state.src === s.id ? ' on' : ''),
        text: s.label, title: s.title
      });
      if (state.busy) b.disabled = true;
      b.onclick = function () { useSource(s.id); };
      bar.appendChild(b);
    });
    return bar;
  }

  async function useSource(id) {
    state.src = id;
    if (id === 'dom') { render(); analyze(); return; }

    if (id === 'clip') { await readClipboard(); return; }
    if (id === 'ocr')  { await readScreen(); return; }
    if (id === 'win')  { await showWindowPicker(); return; }
  }

  async function readClipboard() {
    state.busy = true; state.lastError = ''; render();
    const res = await msg('clipboard');
    state.busy = false;
    if (!res || !res.ok) { state.lastError = (res && res.error) || '读剪贴板失败'; render(); return; }
    const t = (res.data && res.data.text) || '';
    if (!t.trim()) { state.lastError = '剪贴板是空的。先选中买家的话按 Ctrl+C，再点「剪贴板」。'; render(); return; }
    await runAnalyze(t, '剪贴板');
  }

  async function readScreen() {
    state.busy = true; state.lastError = ''; toast('正在截屏识别…'); render();
    const res = await msg('ocr-page', { country: state.country, platform: state.platform });
    state.busy = false;
    if (!res || !res.ok) { state.lastError = (res && res.error) || '截屏失败'; render(); return; }
    const ocr = res.data && res.data.ocr;
    const t = (ocr && ocr.text) || '';
    if (!t.trim()) { state.lastError = '没从截图里识别到文字。换个屏幕区域或改用「剪贴板」。'; render(); return; }
    state.ocrInfo = ocr;
    await runAnalyze(t, '读屏 OCR · ' + (ocr.language_used || ''));
  }

  async function showWindowPicker() {
    state.busy = true; render();
    const res = await msg('windows');
    state.busy = false;
    const wins = (res && res.ok && res.data && res.data.windows) || [];
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'banner warn', text: '选择一个要读取的窗口。列表里是当前所有可见窗口。' }));
    if (!wins.length) {
      body.appendChild(h('div', { class: 'empty', text: '没取到窗口列表' }));
      const b = h('button', { class: 'btn', text: '返回', onclick: function () { state.src = 'dom'; render(); } });
      body.appendChild(b);
      return;
    }
    const box = h('div', { class: 'winpick' });
    wins.forEach(function (w) {
      const row = h('div', { class: 'winrow' });
      row.appendChild(h('div', { class: 'wt', text: w.title || '(无标题)' }));
      row.appendChild(h('div', { class: 'wp', text: (w.process || '') + '  hwnd=' + w.hwnd }));
      row.onclick = function () { readWindow(w); };
      box.appendChild(row);
    });
    body.appendChild(box);
    body.appendChild(h('button', { class: 'btn', text: '返回', onclick: function () { state.src = 'dom'; render(); } }));
  }

  async function readWindow(w) {
    state.busy = true; state.lastError = ''; render();
    const res = await msg('uia', { hwnd: w.hwnd, scope: 'window' });   // 注意：msg() 已包一层，这里不能再写 payload
    state.busy = false;
    if (!res || !res.ok) { state.lastError = (res && res.error) || '读窗口失败'; render(); return; }
    const t = (res.data && res.data.text) || '';
    if (!t.trim()) { state.lastError = '该窗口没读到文字（可能是自绘界面，改用「读屏」）。'; render(); return; }
    await runAnalyze(t, '窗口直读 · ' + (w.title || '').slice(0, 20));
  }

  function renderIdle(msgHtml) {
    // ⚠️ 这里**不能**写 body.innerHTML = ''。
    //    那会把上面刚加的"连不上本地服务"横幅和适配器信息一起擦掉，
    //    用户只看到一个空面板，根本没法排查（v0.9 踩过这个坑）。
    const prev = body.querySelector ? body.querySelector('.idlebox') : null;
    if (prev && prev.remove) prev.remove();
    body.appendChild(h('div', { class: 'empty idlebox', html: msgHtml || '还没有读取对话<br>点下面的「读取并生成话术」<br><br><span style="color:var(--primary)">或者在页面上用鼠标选中买家的话，<br>会出现「🔍 分析选中」按钮</span>' }));
  }

  function render() {
    if (!shadow) return;
    body.innerHTML = '';
    try { renderInner(); applyFolds(); }
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
              '<code style="font-size:10.5px;background:#fafbfe;padding:2px 5px;border-radius:3px">' +
              esc(SERVER_URL) + '/api/health</code><br>' +
              '<span style="color:#a3282c;font-size:11px">' + esc(state.serverMsg || '(没有拿到错误信息)') + '</span>' +
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
      h('div', { class: 'kv' }, [h('span', { text: '分析来源' }), h('span', {
        text: state.lastSource || '—'
      })]),
      !ad.verified && (state.selectors.messageList || state.selectors.messageItem)
        ? h('div', { class: 'tiny', style: 'margin-top:6px;color:#8a5706', text: '⚠ 本平台选择器未经验证，如识别不准请用 ⚙ 重新拾取' })
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
        cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '禁止' }), h('span', { html: '<span style="color:#a3282c">' + esc(r.calming.forbidden) + '</span>' })]));
      }
      body.appendChild(cc);
    }

    // 读取状态说明：读到 0 条 / 用的是上次结果，都要明说
    if (state.readNote) {
      body.appendChild(h('div', { class: 'banner warn', text: 'ℹ ' + state.readNote }));
    }

    // 政策依据（这是"符合当地政策"的核心体现）
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

  /* 把"发文本给服务端并渲染"抽出来复用。
     两个入口都会走它：① 页面自动/手动读取  ② 「选中即分析」 */
  async function runAnalyze(text, sourceLabel) {
    if (state.busy) return;
    text = String(text || '').trim();
    if (!text) return;

    state.busy = true;
    state.setupMode = false;      // 从选中分析进来时自动退出配置界面
    state.setupFirstRun = false;
    render();

    const res = await msg('analyze', { text: text, country: state.country, platform: state.platform, category: 'unknown' });
    state.busy = false;

    if (!res || !res.ok) {
      // ⚠️ 这里**绝对不能**把 serverOk 改成 false。
      //    /api/health 可能一直是通的，这只是"这一次 analyze 失败了"。
      state.lastError = (res && res.error) || '未知错误';
      toast('生成失败（连接正常）', false);
      render();
      return;
    }
    state.lastError = '';
    state.serverOk = true;
    state.lastText = text;
    state.lastSource = sourceLabel || '页面读取';
    state.readNote = '';   // 有新结果就清掉上一次的提示
    state.lastResult = res.data.result;
    setStatus(true, '已连接');
    setVisible(true);
    render();
  }

  async function analyze() {
    if (state.busy) return;
    const r = readOnce();
    if (!r.messages.length) {
      // 读到 0 条时不能默默把旧结果留在界面上 ——
      // 那样会出现"显示着话术、却写着消息 0 条"的矛盾状态，用户完全看不懂。
      // 明确标出这是上一次的结果，并写清来源。
      if (state.lastResult) {
        state.readNote = '本页面未识别到对话列表 —— 下方话术来自上一次分析（' +
          (state.lastSource || '未知来源') + '），不是当前页面的内容。';
        toast('未读到对话，下方是上次结果', false);
      } else {
        state.readNote = '没读到对话。请用底部 ⚙ 拾取消息区，或在页面上选中买家的话用「分析选中」。';
        toast('没读到对话，请用 ⚙ 拾取消息区', true);
      }
      render();
      return;
    }
    state.readNote = '';
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
    await runAnalyze(text, '页面读取');
  }

  /* =====================================================================
     选中即分析 —— 通用兜底，任何平台第一天就能用
     不用等适配器识别出消息列表：鼠标选中买家的一段话，点一下按钮就分析。
     这是最不依赖平台 DOM 的入口，也是新平台接入的首选方式。
     ===================================================================== */
  let selBtn = null;

  function ensureSelBtn() {
    if (selBtn) return selBtn;
    selBtn = document.createElement('button');
    selBtn.type = 'button';
    selBtn.textContent = '🔍 分析选中';
    // 它挂在宿主页面（不在 Shadow DOM 里），所以样式得内联
    selBtn.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'display:none',
      'padding:7px 13px', 'border:none', 'border-radius:9px',
      'background:#2f6bff', 'color:#fff',
      'font:600 12px/1.2 "Segoe UI","Microsoft YaHei",sans-serif',
      'cursor:pointer', 'box-shadow:0 4px 14px rgba(47,107,255,.42)'
    ].join(';');
    // 阻止默认行为，否则点按钮会把选区弄丢
    selBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    selBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = selBtn.__text || '';
      hideSelBtn();
      try { window.getSelection().removeAllRanges(); } catch (err) {}
      if (t) runAnalyze(t, '选中文本');
    });
    document.documentElement.appendChild(selBtn);
    return selBtn;
  }

  function hideSelBtn() { if (selBtn) selBtn.style.display = 'none'; }

  function showSelBtn(rect) {
    const b = ensureSelBtn();
    b.style.display = 'block';
    const bw = b.offsetWidth || 104, bh = b.offsetHeight || 30;
    let left = rect.left + rect.width / 2 - bw / 2;
    let top = rect.top - bh - 8;
    if (top < 4) top = rect.bottom + 8;                        // 贴顶了就放下面
    left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
    top = Math.max(4, Math.min(top, window.innerHeight - bh - 4));
    b.style.left = left + 'px';
    b.style.top = top + 'px';
  }

  document.addEventListener('mouseup', function (e) {
    // 点在自己面板/按钮上不处理
    if (e.target === selBtn) return;
    if (e.target && e.target.closest && e.target.closest('[data-aih-ui]')) return;
    setTimeout(function () {
      let sel = '';
      try { sel = String(window.getSelection() || '').trim(); } catch (err) { return; }
      if (!sel || sel.length < 4) { hideSelBtn(); return; }
      if (sel.length > 4000) sel = sel.slice(0, 4000);
      let rect = null;
      try { rect = window.getSelection().getRangeAt(0).getBoundingClientRect(); } catch (err) {}
      if (!rect || (!rect.width && !rect.height)) { hideSelBtn(); return; }
      const b = ensureSelBtn();
      b.__text = sel;
      showSelBtn(rect);
    }, 10);
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (e.target === selBtn) return;
    hideSelBtn();
  }, true);
  document.addEventListener('scroll', hideSelBtn, true);
  window.addEventListener('resize', hideSelBtn, true);
  window.addEventListener('resize', function () { if (state.uiMode === 'float') applyUi(); }, true);

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
    bar.appendChild(h('div', { class: 'sec', text: '读取源' }));
    bar.appendChild(renderSourceBar());
    bar.setAttribute('data-nofold', '1');
    bar.appendChild(h('div', { class: 'sec', text: '操作', style: 'margin-top:4px' }));
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

    // 读取小窗形态偏好（按站点记忆）
    await new Promise(function (res) { loadUiPrefs(res); });
    await new Promise(function (res) { loadFolds(res); });

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
        // 注意：这里在 setInterval 回调里（非 async），不能 await。
        // 形态偏好很少变，SPA 切路由时不必重读。
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
