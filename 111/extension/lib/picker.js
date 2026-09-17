/* =====================================================================
   lib/picker.js  ·  可视化选择器拾取器
   
   为什么需要它：
     平台的 DOM 结构会随时改版，而且我无法登录你的后台去查看真实结构。
     与其硬编码一个很快会失效的选择器，不如让扩展自己"学会"：
     用户点一条消息 → 自动泛化成能匹配整组的选择器 → 存进 chrome.storage。
     这样换平台、平台改版，都只需要重新点一次，不用改代码。
   ===================================================================== */

const AIH = window.AIH || (window.AIH = {});

AIH.Picker = (function () {
  let active = false;
  let overlay = null, tip = null;
  let curEl = null, onDone = null, mode = 'list';

  function ensureUI() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-aih-ui', '1');
    overlay.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'pointer-events:none',
      'border:2px solid #3b82f6', 'background:rgba(59,130,246,.14)',
      'border-radius:4px', 'display:none', 'box-sizing:border-box',
      'transition:all .04s linear'
    ].join(';');
    document.documentElement.appendChild(overlay);

    tip = document.createElement('div');
    tip.setAttribute('data-aih-ui', '1');
    tip.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none',
      'background:#0e1116', 'color:#e6e9ef', 'border:1px solid #3b82f6',
      'font:12px/1.5 Consolas,monospace', 'padding:5px 9px', 'border-radius:5px',
      'max-width:70vw', 'white-space:nowrap', 'overflow:hidden',
      'text-overflow:ellipsis', 'display:none'
    ].join(';');
    document.documentElement.appendChild(tip);
  }

  function paint(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.getAttribute && el.getAttribute('data-aih-ui')) return;
    curEl = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';

    const sel = mode === 'input' ? AIH.cssPath(el) : AIH.generalizeToGroup(el);
    const count = mode === 'input' ? 1 : safeCount(sel);
    const txt = AIH.textOf(el).slice(0, 60);
    tip.style.display = 'block';
    tip.textContent = (count > 1 ? `匹配 ${count} 个 · ` : '') + sel + (txt ? '   « ' + txt : '');
    const tr = tip.getBoundingClientRect();
    let top = r.top - 30;
    if (top < 4) top = Math.min(r.bottom + 6, window.innerHeight - 30);
    tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tr.width - 8)) + 'px';
    tip.style.top = top + 'px';
  }

  function safeCount(sel) {
    try { return sel ? document.querySelectorAll(sel).length : 0; } catch (e) { return 0; }
  }

  function onMove(e) {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== curEl) paint(el);
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = curEl;
    const sel = mode === 'input' ? AIH.cssPath(el) : AIH.generalizeToGroup(el);
    stop();
    if (onDone) onDone({ ok: true, selector: sel, count: safeCount(sel), sample: AIH.textOf(el).slice(0, 80), mode });
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); stop(); if (onDone) onDone({ ok: false, cancelled: true, mode }); }
  }

  function stop() {
    active = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay) overlay.style.display = 'none';
    if (tip) tip.style.display = 'none';
    curEl = null;
  }

  return {
    start(m, cb) {
      ensureUI();
      stop();
      mode = m || 'list';
      onDone = cb;
      active = true;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    },
    stop,
    isActive() { return active; }
  };
})();
