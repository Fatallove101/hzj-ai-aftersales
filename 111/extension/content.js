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
    view: 'main',          // main | setup | windows | picker
    viewStack: [],
    src: 'dom',
    pickWindow: false,      // 是否处于「选窗口」模式（在①号框内显示）
    pickWindows: [],
    pickLoading: false,
    manualText: '',         // 手动输入框里的内容
    editCand: null,         // 正在编辑的候选
    editRes: null,
    editZh: '',             // 编辑中的中文
    editTar: '',            // 同步后的外文
    editSyncing: false,
    editMsg: '',
    busySince: 0,           // 本次分析开始的时间戳（用于显示已等待秒数）
    folds: {},
    ocrInfo: null,
    uiMode: 'dock',        // dock=挤开页面  float=悬浮可拖动
    uiSize: 'normal',
    pos: { x: -1, y: -1 },
    _baseMargin: undefined,   // 原始页面留白（启动时记一次）
    lastResult: null,
    serverOk: false,
    lastError: '',
    serverMsg: '',
    // 模型配置界面（首次使用时要输入自己的 API Key，替代传统"登录"）
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

  /* 记录"原始页面留白"基线。
     ⚠️ 必须在**改动任何样式之前**调用一次（buildPanel 最开始），不能在使用时懒惰捕获。
     懒惰捕获的坑：如果页面在我们注入之前就带着 marginRight（上次注入残留），
     捕获到的就是那个值，于是"收起"永远还原不回去。
     启动时记一次、之后只读不写，行为才是确定的。 */
  function captureBaseMargin() {
    try {
      const html = document.documentElement;
      if (state._baseMargin === undefined) state._baseMargin = html.style.marginRight || '';
    } catch (e) { state._baseMargin = ''; }
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
      html.style.marginRight = state._baseMargin || '';
      html.style.overflowX = '';
    } else {
      panel.classList.remove('float');
      panel.style.left = ''; panel.style.top = '';
      panel.style.width = ''; panel.style.height = '';
      if (state.visible) {
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
/* ---------- 三个可滚动框（主界面骨架）----------
   为什么这么分：面板宽度只有 392px，纵向空间是稀缺资源。
   把"读到的客户话""可发送的话术""诊断信息"分成三个各自可滚动的框，
   每个框都能独立翻，就不会出现"话术被平台信息挤到屏幕外"的情况。 */
.panes{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px}
.pane{display:flex;flex-direction:column;min-height:0;background:var(--card);
  border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.pane-hd{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 10px;
  border-bottom:1px solid var(--border);background:#fafbfe;flex-wrap:wrap}
.pane-hd .pt{font-size:12px;font-weight:600;flex:1;min-width:0}
.pane-hd .pn{font-size:10.5px;color:var(--muted);font-weight:400}
.pane-bd{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 11px}
.pane-bd::-webkit-scrollbar{width:8px}
.pane-bd::-webkit-scrollbar-thumb{background:#cfd8e8;border-radius:4px}
/* ① 客户对话：中等高度 */
#paneChat{flex:0 0 auto;height:246px}
/* ② 候选话术：占剩下的全部（最大） */
#paneCands{flex:1 1 auto;min-height:150px}
/* ③ 详情：包住那些下拉栏 */
#paneDetail{flex:0 0 auto;height:228px}   /* 152 × 1.5：详情里的下拉栏和折叠卡显示太小 */
.pane-bd .card:last-child,.pane-bd .fold:last-child{margin-bottom:0}
/* 对话气泡（客户对话框内） */
.chatmsg{margin-bottom:9px}
.chatmsg .cm-who{font-size:10px;color:var(--muted);margin-bottom:3px}
.chatmsg .cm-txt{background:#f7f9fd;border-left:3px solid #8a919f;border-radius:7px;
  padding:7px 9px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.chatmsg.buyer .cm-txt{border-left-color:#2f6bff;background:#f5f8ff}
.chatmsg.bot   .cm-txt{border-left-color:#7c5cff;background:#f8f6ff;color:#5b6472}
.chatmsg.human .cm-txt{border-left-color:#18a058;background:#f4fbf7}
.chatmsg .cm-zh{margin-top:4px;font-size:11.5px;color:#5b6472;background:#fafbfe;
  border:1px dashed var(--border);border-radius:7px;padding:6px 9px;line-height:1.6;white-space:pre-wrap}
.termchip{display:inline-block;font-size:10.5px;background:var(--primary-soft);color:#2456d6;
  border-radius:6px;padding:2px 7px;margin:4px 4px 0 0}
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
/* ---------- 多行文本输入框 ----------
   ⚠️ 扩展里用了 .rawtext 这个 class（手动输入框、修改后采纳的中文/外文框），
   但 CSS 里**从头到尾没定义过** —— 于是走浏览器默认样式：白底 + 深色边框，
   在浅色面板里非常突兀（用户反馈"颜色较深有点突兀"）。
   这里按网页版一致的规格补上：淡底、浅描边、圆角、铺满宽度。 */
/* 自定义规则条目（对应网页版 .ruleitem）——
   新增的设置页要用，但扩展的 CSS 里没有，被 class 完整性检查抓出来了 */
.ruleitem{
  display:flex; align-items:center; gap:9px;
  background:#f7f9fd; border:1px solid var(--border); border-radius:10px;
  padding:9px 11px; margin-top:8px;
}
.ruleitem .tiny{margin-top:3px;font-family:Consolas,monospace;word-break:break-all}
.rawtext{
  width:100%; box-sizing:border-box; min-height:96px; resize:vertical;
  background:#fafbfe; color:#5b6472;
  border:1px solid var(--border); border-radius:9px;
  padding:9px 11px; font-size:12.5px; font-family:inherit; line-height:1.65;
}
.rawtext:focus{outline:none; border-color:var(--primary); background:var(--card)}
.rawtext::placeholder{color:var(--muted)}
/* 手动输入框：给足高度，粘贴多轮对话时不憋屈 */
.manualbox{min-height:132px;width:100%;font-size:12.5px;line-height:1.7;resize:vertical}
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
      // 固定位置的返回按钮：只在子页面出现，位置永远不变
      h('button', { class: 'btn sm hidden', id: 'btnBack', text: '←', title: '返回上一级（Esc）',
        onclick: () => popView() }),
      h('button', { class: 'btn sm', text: '🔑', title: '模型 / API Key 设置',
        onclick: () => pushView('setup') }),
      h('button', { class: 'btn sm', text: '⌖', title: '重新拾取选择器', onclick: () => pushView('picker') }),
      h('button', { class: 'btn sm', text: '⚙', title: '设置（知识源 / 自定义规则）',
        onclick: () => pushView('settings') })
    ]);
    // （原来这里还有两行 ft.querySelector('#st').id = 'st' —— 纯多余，
    //   h() 里的 id 已经通过 setAttribute 设好了，删掉）
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
        html.style.marginRight = state._baseMargin || '';
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

  /* ---------------- 子页面导航 ----------------
     所有子页面（模型设置 / 拾取选择器 / 选窗口）都进同一个栈，
     页脚固定位置永远有「← 返回」。

     为什么要这样：之前返回按钮散落在各个子页面内部（表单里、列表下面），
     用户每次都得先找它在哪 —— 这是直接收到的反馈。固定在页脚后，
     位置永远不变，肌肉记忆就建立了。Esc 也能返回。 */
  function pushView(v) {
    if (state.view !== v) state.viewStack.push(state.view);
    state.view = v;
    syncBackBtn();
    render(); renderFooterButtons();
  }

  function popView() {
    state.view = state.viewStack.length ? state.viewStack.pop() : 'main';
    syncBackBtn();
    render(); renderFooterButtons();
  }

  function resetView() {
    state.view = 'main';
    state.viewStack = [];
    syncBackBtn();
  }

  function syncBackBtn() {
    if (!shadow) return;
    const b = shadow.querySelector('#btnBack');
    if (b) {
      b.classList.toggle('hidden', state.view === 'main');
      b.title = '返回上一级（Esc）';
    }
  }

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
    // 三框布局已经把辅助卡片放进③「详情」框了，这里只做"折叠"，**不再搬位置**。
    // （旧的两段式布局会把卡片移到 body 末尾；在三框下那样做会把卡片从③号框里拽出来）
    Array.prototype.slice.call(body.querySelectorAll('.pane-bd .card')).forEach(function (c) {
      makeCollapsible(c);
    });
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
    { id: 'ocr',  label: '读屏',   title: '截当前标签页做 OCR（DOM 读不到时用）' },
    { id: 'manual', label: '手动', title: '自己粘贴或输入对话 —— 任何来源都能用' },
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
    state.pickWindow = false;      // 切到别的读法时关掉窗口选择
    state.src = id;
    if (id === 'dom') { render(); analyze(); return; }

    if (id === 'clip') { await readClipboard(); return; }
    if (id === 'ocr')  { await readScreen(); return; }
    if (id === 'manual') { render(); return; }   // 手动：只在①号框里显示输入框
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

  /* 选窗口：**在①「客户对话」框内部显示**，不整屏接管。
     之前是 body.innerHTML = '' 把整块面板换掉 —— 结果上面的读取源按钮排
     跟着消失，用户想换个读法都没法点（收到反馈）。
     现在只把①号框的内容换成窗口列表，标题栏（含读取源）保留不动。 */
  async function showWindowPicker() {
    state.pickWindow = true;
    state.pickWindows = [];
    state.pickLoading = true;
    state.lastError = '';
    render();
    const res = await msg('windows');
    state.pickLoading = false;
    const wins = (res && res.ok && res.data && res.data.windows) || [];
    state.pickWindows = wins;
    if (!wins.length) state.lastError = '没取到窗口列表：' + ((res && res.error) || '未知原因');
    render();
  }

  async function readWindow(w) {
    state.pickWindow = false;      // 选完就退出选择态
    state.pickWindows = [];
    state.busy = true; state.lastError = ''; render();
    const res = await msg('uia', { hwnd: w.hwnd, scope: 'window' });   // 注意：msg() 已包一层，这里不能再写 payload
    state.busy = false;
    if (!res || !res.ok) { state.lastError = (res && res.error) || '读窗口失败'; render(); return; }
    const t = (res.data && res.data.text) || '';
    if (!t.trim()) { state.lastError = '该窗口没读到文字（可能是自绘界面，改用「读屏」）。'; render(); return; }
    await runAnalyze(t, '窗口直读 · ' + (w.title || '').slice(0, 20));
  }

  /* ---------------- 三个可滚动框 ---------------- */
  function buildPanes() {
    // ⚠️ 必须有这个外层容器，并且必须作为 root 返回。
    //    之前漏了 root —— renderInner 里 body.appendChild(panes.root) 拿到 undefined，
    //    报 "parameter 1 is not of type 'Node'"（用户在浏览器里直接撞到）。
    const root = h('div', { class: 'panes' });

    function mk(id, title, extra) {
      const p = h('div', { class: 'pane', id: id });
      const hd = h('div', { class: 'pane-hd' });
      hd.appendChild(h('span', { class: 'pt', text: title }));
      if (extra) hd.appendChild(extra);
      const bd = h('div', { class: 'pane-bd' });
      p.appendChild(hd); p.appendChild(bd);
      root.appendChild(p);                 // 挂进容器
      return { root: p, hd: hd, bd: bd };
    }

    // ① 客户对话：读取源按钮 + 分析按钮都在这个框的标题栏里
    const chat = mk('paneChat', '客户对话', h('span', { class: 'pn', id: 'chatCount', text: '' }));
    const ctl = h('div', { id: 'chatHdCtl', style: 'flex:1 0 100%;margin-top:6px' });
    chat.hd.appendChild(ctl);
    // ② 候选话术（最大）
    const cands = mk('paneCands', '候选话术', h('span', { class: 'pn', id: 'candCount', text: '' }));
    // 「换一批」：重新读取当前对话并刷新②号框的候选话术。
    // 放在候选话术标题旁而不是上面操作条里 —— 它作用的正是这个框的内容，
    // 按钮和它影响的东西应该挨着（原来叫「分析」，用户反馈看不懂）。
    cands.hd.appendChild(h('button', {
      class: 'btn sm pri', text: (state.busy ? ('生成中 ' + Math.round((Date.now() - (state.busySince || Date.now())) / 1000) + 's') : '换一批'), title: '重新读取当前对话，刷新下方候选话术',
      onclick: () => analyze(true)   // 换一批 = 强制重新生成
    }));
    // ③ 详情：包住所有折叠卡片
    const detail = mk('paneDetail', '详情', h('span', { class: 'pn', text: '点标题展开' }));

    return { root: root, chat: chat, cands: cands, detail: detail, ctl: ctl };
  }

  /* 客户对话内容：分说话人气泡 + 中文对照
     诚实说明：本地模式没有整句翻译能力，只能给术语级对照；
     接入千帆后 translation.translated_text 会有整段中文译文。 */
  // 语言显示名（编辑器标题栏用）
  const LANG_LABEL = { en: 'English', es: 'Español', zh: '中文' };
  const SPEAKER_ZH = { buyer: '客户', bot: 'AI客服', human: '人工客服' };

  function buildChatPane(bd, tr, note) {
    bd.innerHTML = '';

    // 选窗口模式：把①号框内容换成窗口列表，**标题栏不动**（读取源按钮仍在）。
    // 之前是整屏替换 body，导致上面的读取源按钮排消失、用户换不了读法。
    if (state.pickWindow) {
      bd.appendChild(h('div', { class: 'sec', text: '选择要读取的窗口' }));
      if (state.pickLoading) { bd.appendChild(h('div', { class: 'tiny', text: '正在获取窗口列表…' })); return; }
      if (!state.pickWindows.length) {
        bd.appendChild(h('div', { class: 'empty', text: '没取到窗口列表' }));
      } else {
        const wp = h('div', { class: 'winpick' });
        state.pickWindows.forEach(function (w) {
          const row = h('div', { class: 'winrow' });
          row.appendChild(h('div', { class: 'wt', text: w.title || '(无标题)' }));
          row.appendChild(h('div', { class: 'wp', text: (w.process || '') + '  hwnd=' + w.hwnd }));
          row.onclick = function () { readWindow(w); };
          wp.appendChild(row);
        });
        bd.appendChild(wp);
      }
      const cancel = h('button', { class: 'btn sm', text: '取消', style: 'margin-top:8px' });
      cancel.onclick = function () { state.pickWindow = false; state.pickWindows = []; render(); };
      bd.appendChild(cancel);
      return;
    }

    // 手动输入：自己粘贴对话。任何来源（第三方系统、截图里抄的、口头转述）都能用。
    if (state.src === 'manual') {
      // 手动输入：自己粘贴对话。任何来源（第三方系统、抄来的、口头转述）都能用。
      const hdRow = h('div', { class: 'row', style: 'margin-bottom:6px' });
      hdRow.appendChild(h('span', { class: 'sec', style: 'margin:0', text: '对话内容（可编辑）' }));
      hdRow.appendChild(h('span', { style: 'flex:1' }));
      const bClr = h('button', { class: 'btn sm ghost', text: '清空' });
      bClr.onclick = function () { state.manualText = ''; render(); };
      hdRow.appendChild(bClr);
      bd.appendChild(hdRow);

      const ta = h('textarea', { class: 'rawtext manualbox' });
      ta.placeholder = '把客户对话粘贴到这里（可多行）。' + String.fromCharCode(10) +
        '中文走本地分析；外文会先翻译再分析；多轮对话直接整段贴进来即可。';
      ta.value = state.manualText || '';
      ta.oninput = function () { state.manualText = ta.value; };
      bd.appendChild(ta);

      const foot = h('div', { class: 'row', style: 'margin-top:9px' });
      const bGo = h('button', { class: 'btn pri sm', text: '用这段对话生成话术' });
      bGo.onclick = function () {
        const t = (state.manualText || '').trim();
        if (!t) { state.lastError = '请先粘贴或输入对话内容'; render(); return; }
        runAnalyze(t, '手动输入');
      };
      foot.appendChild(bGo);
      const cnt = h('span', { class: 'tiny', text: (state.manualText || '').length + ' 字' });
      foot.appendChild(cnt);
      ta.addEventListener('input', function () { cnt.textContent = (state.manualText || '').length + ' 字'; });
      bd.appendChild(foot);
      bd.appendChild(h('div', { class: 'tiny', style: 'margin-top:7px', text: '生成后结果会出现在下面「候选话术」框里。' }));
      return;
    }
    if (note) bd.appendChild(h('div', { class: 'banner warn', text: 'ℹ ' + note }));
    const msgs = state.messages || [];

    if (!msgs.length) {
      bd.appendChild(h('div', { class: 'empty', html:
        '还没有读到对话<br><br><span style="color:var(--primary)">用上面的「页面 / 剪贴板 / 窗口 / 读屏」<br>' +
        '任一方式读取，或直接在页面上选中买家的话</span>' }));
      return;
    }

    // 说话人识别：客户 / AI客服 / 人工客服
    msgs.forEach(function (m) {
      const side = m.side === 'buyer' ? 'buyer' : (m.side === 'seller' ? 'human' : 'bot');
      const w = h('div', { class: 'chatmsg ' + side });
      w.appendChild(h('div', { class: 'cm-who', text: SPEAKER_ZH[side] || '消息' }));
      w.appendChild(h('div', { class: 'cm-txt', text: m.text || '' }));
      bd.appendChild(w);
    });

    // 中文对照
    const box = h('div', { style: 'margin-top:10px' });
    const zh = (tr && tr.translated_text) ? String(tr.translated_text).trim() : '';
    if (zh) {
      box.appendChild(h('div', { class: 'sec', text: '中文对照' }));
      box.appendChild(h('div', { class: 'cm-zh', text: zh }));
    } else {
      const terms = (tr && tr.glossary_hits) || [];
      box.appendChild(h('div', { class: 'sec', text: '术语对照' }));
      if (terms.length) {
        const tc = h('div');
        terms.forEach(function (t) {
          tc.appendChild(h('span', { class: 'termchip', text: t.foreign + ' → ' + t.term_zh }));
        });
        box.appendChild(tc);
      }
      box.appendChild(h('div', { class: 'tiny', style: 'margin-top:6px;line-height:1.7', html:
        (tr && tr.status ? esc(tr.status) + '<br>' : '') +
        '接上千帆后这里会是整句中文译文（对照翻译）。' }));
    }
    bd.appendChild(box);
  }


  function render() {
    if (!shadow) return;
    body.innerHTML = '';
    try { renderInner(); applyFolds(); renderFooterButtons(); }
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
      // 「返回」统一放页脚固定位置，这里不再重复放一个，避免两个返回按钮
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
      resetView();
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
    if (state.view === 'setup') { renderSetup(); return; }
    if (state.view === 'edit') { renderEdit(); return; }
    if (state.view === 'picker') { renderPicker(); return; }
    if (state.view === 'settings') { renderSettings(); return; }

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
    }
    // 连接正常时不占横幅 —— 页脚已有 🟢 已连接，省下的纵向空间留给话术

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

    // ============ 三个可滚动框 ============
    const panes = buildPanes();
    const r = state.lastResult;

    // 高风险警示放在三框之上 —— 这是必须"不滚动就能看到"的信息
    if (r && r.escalation && r.escalation.need_human) {
      body.appendChild(h('div', {
        class: 'banner err',
        html: '<b>⚠ 高风险案件</b>（' + esc(ESC_ZH[r.escalation.reason] || r.escalation.reason || '') +
              '）<br>回复前请核对政策依据，避免口径与该国法规或平台规则冲突。'
      }));
    }

    body.appendChild(panes.root);
    const detailBd = panes.detail.bd;
    const candsBd  = panes.cands.bd;

    // ① 客户对话：有没有分析结果都要渲染 —— 用户得先看到"到底读了什么"
    buildChatPane(panes.chat.bd, r ? r.translation : null, state.readNote);
    const ccEl = panes.chat.hd.querySelector('#chatCount');
    if (ccEl) ccEl.textContent = state.messages.length ? (state.messages.length + ' 条') : '空';
    const candCnt = panes.cands.hd.querySelector('#candCount');
    if (candCnt) candCnt.textContent = r && r.candidates ? (r.candidates.length + ' 条') : '';

    // 适配器
    const ad = state.adapter;
    // ③ 详情框第一张卡：读取设置（国家 / 回复语言）——
    // 用户要求"第三个框把那些下拉栏包裹进去"，放这里不挤占客户对话的空间。
    const cs = h('select', { class: 'sel', style: 'flex:1;min-width:96px',
      onchange: (e) => { state.country = e.target.value; state.lastText = ''; } });
    [['UNKNOWN', '国家：未知'], ['ES', '西班牙'], ['DE', '德国'], ['FR', '法国'],
     ['IT', '意大利'], ['US', '美国'], ['GB', '英国'], ['NL', '荷兰'],
     ['AU', '澳大利亚'], ['JP', '日本']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === state.country) o.selected = true; cs.appendChild(o); });
    const ls = h('select', { class: 'sel', style: 'flex:1;min-width:88px',
      onchange: (e) => { state.targetLang = e.target.value; render(); } });
    [['en', '英文'], ['es', '西语'], ['zh', '中文']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === state.targetLang) o.selected = true; ls.appendChild(o); });
    detailBd.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '读取设置' }),
      h('div', { class: 'row' }, [cs, ls])
    ]));

    detailBd.appendChild(h('div', { class: 'card' }, [
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

    // 没有分析结果：候选话术框给空态，详情框只留平台信息
    // 生成中：给明确的进度反馈。
    // 千帆这个模型单次要 20~40 秒 —— 没有反馈的等待，用户会以为卡死了。
    if (state.busy) {
      const el2 = (Date.now() - (state.busySince || Date.now())) / 1000;
      const bx = h('div', { class: 'empty' });
      bx.appendChild(h('div', { style: 'font-size:22px;margin-bottom:6px', text: '⏳' }));
      bx.appendChild(h('div', { html: '<b>正在生成话术…</b>' }));
      bx.appendChild(h('div', { class: 'tiny', style: 'margin-top:6px;line-height:1.8', html:
        '已等待 <b>' + el2.toFixed(0) + '</b> 秒<br>' +
        '调用千帆大模型通常需要 20~40 秒<br>' +
        '（翻译 + 生成两轮，与提示词长度有关）' }));
      candsBd.appendChild(bx);
      renderFooterButtons();
      return;
    }

    if (!r) {
      candsBd.appendChild(h('div', { class: 'empty', html:
        '还没有生成话术<br><br>点上方「分析」，<br>或用「页面 / 剪贴板 / 窗口 / 读屏」读取对话' }));
      renderFooterButtons();
      return;
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
    detailBd.appendChild(c1);

    // 工单路由 + SLA（技能驱动，来自 ecommerce-intent-routing）
    if (r.routing) {
      const cr = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '工单路由（技能驱动）' })]);
      cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: '分派组' }), h('span', { text: r.routing.group })]));
      cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: 'SLA' }), h('span', { text: r.routing.sla })]));
      if (r.routing.risk && r.routing.risk !== '—') {
        cr.appendChild(h('div', { class: 'kv' }, [h('span', { text: '风险提示' }), h('span', { text: r.routing.risk })]));
      }
      detailBd.appendChild(cr);
    }

    // 情绪安抚策略（技能驱动，来自 customer-reply-craft）
    if (r.calming) {
      const cc = h('div', { class: 'card' }, [h('div', { class: 'sec', text: '情绪安抚策略（技能驱动）' })]);
      cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '情绪级别' }), h('span', { text: r.calming.level + ' / 5' })]));
      cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '处理方式' }), h('span', { text: r.calming.action })]));
      if (r.calming.forbidden && r.calming.forbidden !== '—') {
        cc.appendChild(h('div', { class: 'kv' }, [h('span', { text: '禁止' }), h('span', { html: '<span style="color:#a3282c">' + esc(r.calming.forbidden) + '</span>' })]));
      }
      detailBd.appendChild(cc);
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
      detailBd.appendChild(ce);
    } else if (r.retrieval) {
      detailBd.appendChild(h('div', { class: 'banner warn', text: '未检索到可依据的政策条目 —— 此时不应给出任何政策承诺，请人工核实。' }));
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
      detailBd.appendChild(cs);
    }

    // 候选话术
    const compMap = {};
    (r.compliance || []).forEach(c => compMap[c.candidate_id] = c);
    const recId = r.final.recommended_candidate_id;


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
        cf.appendChild(h('button', { class: 'btn sm', text: '✎ 修改后采纳', onclick: () => openEditor(c, r) }));
      } else {
        cf.appendChild(h('span', { class: 'tag rj', text: '违反合规规则，不可发送' }));
      }
      cf.appendChild(h('button', { class: 'btn sm', text: '✕', title: '忽略', onclick: () => fb('ignore', c, r) }));
      card.appendChild(cf);
      candsBd.appendChild(card);
    });

    // 底部信息
    candsBd.appendChild(h('div', { class: 'tiny', style: 'margin-top:4px', html:
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

  async function fb(action, cand, res, finalText) {
    if (!res) return;
    await msg('feedback', {
      trace_id: res.trace_id, action: action, style: cand.style,
      candidate_id: cand.candidate_id, intent: res.analysis.primary_intent,
      country: res.input.country,
      // 建议原文 + 最终发出内容都记下来 —— 服务端据此算「人工修改幅度」
      suggested_text: cand.text_zh || '',
      final_text: finalText != null ? finalText : (cand.text_zh || '')
    });
    toast('已记录：' + ({ accept: '采纳', ignore: '忽略', edit: '修改采纳' }[action] || action));
  }

  /* ---------------- 修改后采纳 ----------------
     比网页版多做一步：改中文，外文自动同步。

     为什么必须同步：中文是给内部看的、外文才是发给客户的。
     只改中文不同步外文，就会出现「内部记录一套、实际发出去另一套」——
     这在合规场景里是致命的（记录说我承诺了 A，客户收到的是 B）。
     同步靠 /api/retranslate 回译；回译失败会明确提示，不会假装成功。 */
  function openEditor(cand, res) {
    state.editCand = cand;
    state.editRes = res;
    state.editZh = cand.text_zh || '';
    state.editTar = pickTarget(cand) || '';   // 函数名是 pickTarget，不是 pickText
    state.editMsg = '';
    state.editSyncing = false;
    pushView('edit');
  }

  let syncTimer = null;

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    state.editSyncing = true;
    state.editMsg = '正在同步外文…';
    updateSyncHint();
    // 停输入 1 秒再回译，避免每敲一个字就打一次模型
    syncTimer = setTimeout(doSync, 1000);
  }

  async function doSync() {
    const zh = (state.editZh || '').trim();
    if (!zh) { state.editSyncing = false; state.editMsg = ''; updateSyncHint(); return; }
    const res = await msg('retranslate', { text_zh: zh, target: state.targetLang });
    state.editSyncing = false;
    if (res && res.ok && res.data && res.data.text_tar) {
      state.editTar = res.data.text_tar;
      state.editMsg = '✓ 外文已同步';
      const ta = shadow.querySelector('#editTar');
      if (ta) ta.value = state.editTar;
    } else {
      state.editMsg = '⚠ 外文未同步：' +
        ((res && res.data && res.data.error) || (res && res.error) || '模型未接入') +
        ' —— 插入前请自己核对';
    }
    updateSyncHint();
  }

  function updateSyncHint() {
    const hEl = shadow.querySelector('#editSyncHint');
    if (!hEl) return;
    hEl.textContent = state.editMsg || '';
    hEl.style.color = state.editMsg.indexOf('⚠') === 0 ? 'var(--danger)' : 'var(--ok)';
  }

  function renderEdit() {
    body.innerHTML = '';
    const c = state.editCand;
    if (!c) { body.appendChild(h('div', { class: 'empty', text: '没有要编辑的话术' })); return; }

    body.appendChild(h('div', { class: 'banner ok', html:
      '<b>修改后采纳</b><br>改下面的<b>中文</b>，上面的外文会自动重新翻译；确认后直接插入输入框。' }));

    body.appendChild(h('div', { class: 'sec', text: '发给客户 · ' + (LANG_LABEL[state.targetLang] || state.targetLang) }));
    const tar = h('textarea', { class: 'rawtext', id: 'editTar', style: 'min-height:118px' });
    tar.value = state.editTar;
    tar.oninput = function () { state.editTar = tar.value; };
    body.appendChild(tar);
    body.appendChild(h('div', { class: 'tiny', id: 'editSyncHint', style: 'margin-top:5px' }));

    body.appendChild(h('div', { class: 'sec', style: 'margin-top:12px', text: '中文（改这里 · 自动触发回译）' }));
    const zh = h('textarea', { class: 'rawtext', id: 'editZh', style: 'min-height:130px' });
    zh.value = state.editZh;
    zh.oninput = function () { state.editZh = zh.value; scheduleSync(); };
    body.appendChild(zh);

    const row = h('div', { class: 'row', style: 'margin-top:12px' });
    const bIns = h('button', { class: 'btn pri', text: '⤵ 插入输入框（用外文）' });
    bIns.onclick = function () {
      const t = (state.editTar || '').trim();
      if (!t) { toast('外文是空的，先等同步或自己填', false); return; }
      insertToInput(t);
      fb('edit', c, state.editRes, state.editZh);
    };
    row.appendChild(bIns);

    const bCopy = h('button', { class: 'btn', text: '📋 复制外文' });
    bCopy.onclick = function () { copy(state.editTar || ''); };
    row.appendChild(bCopy);

    const bSync = h('button', { class: 'btn', text: '↻ 重新同步' });
    bSync.onclick = function () { scheduleSync(); };
    row.appendChild(bSync);

    const bDone = h('button', { class: 'btn', text: '仅记录采纳' });
    bDone.onclick = function () { fb('edit', c, state.editRes, state.editZh); popView(); };
    row.appendChild(bDone);
    body.appendChild(row);

    body.appendChild(h('div', { class: 'tiny', style: 'margin-top:8px', html:
      '原始建议：<br>' + esc(c.text_zh || '') }));
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
    state.busySince = Date.now();
    resetView();                  // 从选中分析进来时自动退出子页面
    render();

    const res = await msg('analyze', { text: text, country: state.country, platform: state.platform, category: 'unknown' });
    state.busy = false;
    state.busySince = 0;

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

  async function analyze(force) {
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
    // 「换一批」要的是**重新生成**，不是"文本没变就跳过"。
    // 只有自动监听才需要去重（避免同一段话反复打模型），所以 force 时才强制重跑。
    if (!force && text === state.lastText && state.lastResult) { render(); return; }
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

  // Esc 返回上一级 —— 和页脚「←」等价，习惯哪个用哪个
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.view === 'main') return;
    e.preventDefault(); e.stopPropagation();
    popView();
  }, true);
  window.addEventListener('resize', function () { if (state.uiMode === 'float') applyUi(); }, true);

  // 生成过程中每秒刷新一次，让「已等待 N 秒」动起来 —— 静止的数字看着就像卡死
  setInterval(function () { if (state.busy && state.view === 'main') render(); }, 1000);

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

  /* 主视图的控件统一挂在①「客户对话」框的标题栏里：
     读取源按钮排 + 分析按钮 + 国家/回复语言。
     这样"读什么、怎么读、什么时候分析"和"读到的内容"在同一个框里，
     不用在面板上下找按钮。 */
  function renderFooterButtons() {
    if (state.view !== 'main') return;          // 子页面不显示主视图控件
    const ctl = shadow && shadow.querySelector('#chatHdCtl');
    if (!ctl) return;                             // 主视图还没渲染出来
    ctl.innerHTML = '';

    ctl.appendChild(renderSourceBar());   // 读取源按钮排（分析按钮已移到候选话术标题旁）

    const row1 = h('div', { class: 'row', style: 'margin-top:6px' });
    row1.appendChild(state.watching
      ? h('button', { class: 'btn dan sm', text: '⏹ 停止', onclick: stopWatch })
      : h('button', { class: 'btn sm', text: '▶ 自动监听', onclick: startWatch }));
    row1.appendChild(h('button', { class: 'btn sm', text: '↻', title: '强制重读',
      onclick: () => { state.lastText = ''; analyze(); } }));
    ctl.appendChild(row1);

    // 国家 / 回复语言两个下拉放进③「详情」框 —— 见 renderInner 的「读取设置」卡
  }

  /* ---------------- 选择器拾取 ---------------- */
  /* 拾取菜单。
     ⚠️ 这个函数曾经叫 openPickerMenu，自己设置 state.view；
     导航重构后入口改成了 pushView('picker')，但 renderInner 里**没补 picker 分支**，
     于是它变成"定义了但没人调用"的死代码 —— 点 ⚙ 只会落回主视图，看起来像返回主页。
     函数体里还残留 candsBd（三框重构后的局部变量，这里根本不存在），
     所以就算恢复调用也会立刻 ReferenceError。两个问题一起修：
       1. 改名 renderPicker，只负责画内容，视图切换交给 pushView
       2. candsBd -> body
       3. 去掉重复的「← 返回」按钮（页脚已有固定位置的返回键） */
  /* ---------------- 设置（对应网页版的「设置」页） ----------------
     与网页版保持一致，但**不含 API Key 部分** —— 那部分已经由页脚 🔑 单独承载。
     三块：生效模式 / 知识源 / 自定义禁用表述。 */
  function renderSettings() {
    body.innerHTML = '';

    // ---- ① 生效模式 ----
    const cardM = h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '生效模式' }),
      h('div', { class: 'tiny', id: 'setModelBody', text: '加载中…' })
    ]);
    body.appendChild(cardM);

    // ---- ② 知识源 ----
    const cardK = h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '知识源' }),
      h('div', { class: 'tiny', id: 'setKbBody', text: '加载中…' })
    ]);
    body.appendChild(cardK);

    // ---- ③ 自定义禁用表述 ----
    const cardR = h('div', { class: 'card' }, [
      h('div', { class: 'sec', text: '自定义禁用表述' }),
      h('div', { class: 'tiny', text: '命中的话术会被标记为需修订或直接拦截，可与内置规则叠加。' }),
      h('div', { class: 'tiny', id: 'setRulesBody', text: '加载中…' })
    ]);
    body.appendChild(cardR);

    loadModelSection();
    loadKbSection();
    loadRulesSection();
  }

  function kvRow(k, v) {
    return h('div', { class: 'kv' }, [
      h('span', { text: k }),
      h('span', { html: v })
    ]);
  }

  async function loadModelSection() {
    const el2 = shadow.querySelector('#setModelBody');
    if (!el2) return;
    const res = await msg('health');
    const m = (res && res.ok && res.data && res.data.model) || null;
    el2.innerHTML = '';
    if (!m) { el2.textContent = '读不到（本地服务未启动？）'; return; }
    el2.appendChild(kvRow('生效模式', m.mode === 'model'
      ? '<span style="color:var(--ok)">外部模型</span>' : '本地规则引擎'));
    el2.appendChild(kvRow('provider', esc(m.provider || 'local')));
    el2.appendChild(kvRow('模型名', esc(m.model || '（未设置）')));
    el2.appendChild(kvRow('接口地址', m.endpoint_set ? '已设置' : '（未设置）'));
    el2.appendChild(h('div', { class: 'tiny', style: 'margin-top:6px', html:
      '密钥相关请用页脚 <b>🔑</b>。' }));
  }

  async function loadKbSection() {
    const el2 = shadow.querySelector('#setKbBody');
    if (!el2) return;
    const res = await msg('knowledge');
    const k = (res && res.ok && res.data && res.data.knowledge) || null;
    el2.innerHTML = '';
    if (!k) { el2.textContent = '读不到知识源状态（本地服务未启动？）'; return; }

    el2.appendChild(kvRow('当前生效', '<b>' + esc(k.active_label || '-') + '</b>'));
    el2.appendChild(kvRow('本地知识库', k.local_ready ? ('✅ 就绪 · ' + k.local_count + ' 条政策') : '❌ 未加载'));
    el2.appendChild(kvRow('千帆知识库', k.qianfan_ready ? '✅ 已配置' : '⬜ 未配置'));
    if (k.degraded) {
      el2.appendChild(h('div', { class: 'banner warn', text: '⚠ 已降级：' + (k.degrade_reason || '') }));
    }

    const sel = h('select', { class: 'sel', style: 'margin-top:8px' });
    [['local', '本地 CSV 知识库（开箱即用）'], ['qianfan', '千帆知识库（MCP / AppBuilder）']]
      .forEach(function (o) {
        const op = h('option', { value: o[0], text: o[1] });
        if (o[0] === k.configured) op.selected = true;
        sel.appendChild(op);
      });
    const ep = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: '千帆检索端点，如 http://127.0.0.1:8080/mcp/search' });
    ep.value = k.qianfan_endpoint || '';
    const aid = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: 'AppBuilder 应用 ID（选填）' });
    aid.value = k.qianfan_app_id || '';
    const ds = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: '知识库 / 数据集 ID（选填）' });
    ds.value = k.qianfan_dataset || '';

    const kmsg = h('div', { class: 'tiny', style: 'margin-top:7px' });
    const row = h('div', { class: 'row', style: 'margin-top:9px' });

    const bs = h('button', { class: 'btn pri sm', text: '保存' });
    bs.onclick = async function () {
      bs.disabled = true; bs.textContent = '保存中…';
      const r = await msg('knowledge', {
        provider: sel.value,
        qianfan_endpoint: ep.value.trim(),
        qianfan_app_id: aid.value.trim(),
        qianfan_dataset: ds.value.trim()
      });
      bs.disabled = false; bs.textContent = '保存';
      if (!r || !r.ok) { kmsg.innerHTML = '<span style="color:var(--danger)">' + esc((r && r.error) || '保存失败') + '</span>'; return; }
      toast('已保存');
      loadKbSection();
    };
    row.appendChild(bs);

    const bt = h('button', { class: 'btn sm', text: '测试连接' });
    bt.onclick = async function () {
      bt.disabled = true; bt.textContent = '测试中…';
      const r = await msg('knowledge', { test: true });
      bt.disabled = false; bt.textContent = '测试连接';
      const t = (r && r.ok && r.data && r.data.result) || {};
      kmsg.innerHTML = t.ok
        ? '<span style="color:var(--ok)">✓ 连接成功（' + t.latency_ms + 'ms，返回 ' + ((t.sample || []).length) + ' 条样本）</span>'
        : '<span style="color:var(--warn)">✕ ' + esc(t.reason || (r && r.error) || '失败') + '（' + (t.latency_ms || 0) + 'ms）</span>';
    };
    row.appendChild(bt);

    el2.appendChild(sel); el2.appendChild(ep); el2.appendChild(aid); el2.appendChild(ds);
    el2.appendChild(row); el2.appendChild(kmsg);
    el2.appendChild(h('div', { class: 'tiny', style: 'margin-top:6px', html:
      '⚠ 千帆路径尚未对接真实接口，契约见 docs/接入千帆知识库.md；' +
      '字段名不同只需改 engine/knowledge.ps1 的映射。' }));
  }

  async function loadRulesSection() {
    const el2 = shadow.querySelector('#setRulesBody');
    if (!el2) return;
    const res = await msg('rules');
    const list = (res && res.ok && res.data && res.data.rules) || [];
    el2.innerHTML = '';

    // 已有规则
    if (!list.length) {
      el2.appendChild(h('div', { class: 'tiny', text: '（还没有自定义规则）' }));
    } else {
      list.forEach(function (r) {
        const rowR = h('div', { class: 'ruleitem' }, [
          h('div', { style: 'flex:1' }, [
            h('div', { style: 'font-weight:600', text: r.title || '(未命名)' }),
            h('div', { class: 'tiny', text: (r.pattern || '') + '   ·   ' + (r.severity === 'block' ? '拦截' : '警告') + (r.valid === false ? '   ⚠ 正则有误' : '') })
          ])
        ]);
        const bd = h('button', { class: 'btn sm ghost', text: '删除' });
        bd.onclick = async function () {
          bd.disabled = true;
          // 字段名必须是 delete —— 服务端（和网页版）都用 delete，写 remove 会 400
          const rr = await msg('rules', { delete: r.id });
          if (rr && rr.ok) { toast('已删除'); loadRulesSection(); }
          else { toast((rr && rr.error) || '删除失败', false); bd.disabled = false; }
        };
        rowR.appendChild(bd);
        el2.appendChild(rowR);
      });
    }

    // 新增表单
    const ti = h('input', { class: 'sel', style: 'margin-top:10px', placeholder: '规则名（如：禁止概不退换）' });
    const pi = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: '关键词或正则（如：概不退换|不退不换）' });
    const si = h('select', { class: 'sel', style: 'margin-top:7px' });
    [['warn', '警告（标记为需修订）'], ['block', '拦截（直接判为不可发送）']].forEach(function (o) {
      si.appendChild(h('option', { value: o[0], text: o[1] }));
    });
    const ri = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: '原因（选填，会显示给坐席）' });
    const gi = h('input', { class: 'sel', style: 'margin-top:7px', placeholder: '改写建议（选填）' });

    const rmsg = h('div', { class: 'tiny', style: 'margin-top:7px' });
    const ba = h('button', { class: 'btn pri sm', text: '＋ 添加规则', style: 'margin-top:9px' });
    ba.onclick = async function () {
      if (!pi.value.trim()) { rmsg.innerHTML = '<span style="color:var(--warn)">请填写关键词或正则</span>'; return; }
      ba.disabled = true; ba.textContent = '添加中…';
      const r = await msg('rules', {
        title: ti.value.trim(), pattern: pi.value.trim(), severity: si.value,
        reason: ri.value.trim(), suggestion: gi.value.trim()
      });
      ba.disabled = false; ba.textContent = '＋ 添加规则';
      if (!r || !r.ok) { rmsg.innerHTML = '<span style="color:var(--danger)">' + esc((r && r.error) || '添加失败') + '</span>'; return; }
      const warns = (r.data && r.data.warnings) || [];
      if (warns.length) {
        // 服务端会拿合规正向样本试一遍，命中说明规则过于宽泛，可能误杀正常话术
        toast('已添加，但可能误杀', false);
        rmsg.innerHTML = '<span style="color:var(--warn)">' + warns.map(esc).join('<br>') + '</span>';
        loadRulesSection();
        return;
      }
      toast('已添加');
      loadRulesSection();
    };

    el2.appendChild(ti); el2.appendChild(pi); el2.appendChild(si);
    el2.appendChild(ri); el2.appendChild(gi); el2.appendChild(ba); el2.appendChild(rmsg);
  }
  function renderPicker() {
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
    items.forEach(function (it) {
      body.appendChild(h('div', { class: 'card' }, [
        h('div', { style: 'font-weight:600;margin-bottom:4px', text: it.label }),
        h('div', { class: 'tiny', text: it.help }),
        h('div', { class: 'row', style: 'margin-top:8px' }, [
          h('button', { class: 'btn pri sm', text: '开始拾取', onclick: () => beginPick(it) })
        ])
      ]));
    });
    body.appendChild(h('div', { class: 'row', style: 'margin-top:4px' }, [
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
      state.view = 'setup';
      state.viewStack = ['main'];
      state.setupFirstRun = true;
      syncBackBtn();
    }

    render();
    renderFooterButtons();
    setVisible(true);

    // 首次自动读一次（配置界面下不需要）
    setTimeout(() => { if (state.serverOk && state.view === 'main') analyze(); }, 600);

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

  /* 测试钩子。
     只为 tools/test-extension-load.js 做「渲染冒烟测试」而暴露 ——
     不参与任何业务逻辑，也不影响正常使用。
     为什么不靠 boot() 驱动测试：boot() 是 async，内部有 await 链，
     在打桩环境里很容易"什么都没跑就静默通过"（我在这上面栽过）。
     直接调用 buildPanel + render 才是确定性可测的。 */
  AIH.__test = {
    buildPanel: buildPanel,
    render: render,
    renderFooterButtons: renderFooterButtons,
    buildPanes: buildPanes,
    openEditor: openEditor,     // 点击「✎ 修改后采纳」的入口（pickText 未定义就是这么漏的）
    state: state
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
