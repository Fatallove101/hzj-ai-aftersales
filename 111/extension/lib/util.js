/* =====================================================================
   lib/util.js  ·  通用小工具
   ===================================================================== */

const AIH = window.AIH || (window.AIH = {});

AIH.$ = (sel, root) => (root || document).querySelector(sel);
AIH.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** 元素是否真实可见（有尺寸且没被隐藏） */
AIH.isVisible = function (el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
  return true;
};

/** 取元素文本，压缩空白 */
AIH.textOf = function (el) {
  if (!el) return '';
  let t = el.innerText || el.textContent || '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') t = el.value || '';
  return t.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
};

/** 元素签名：tag + class 列表（用于识别"重复的消息项"） */
AIH.signature = function (el) {
  if (!el || !el.tagName) return '';
  let cls = '';
  if (typeof el.className === 'string' && el.className) {
    cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 4).join('.');
  }
  return el.tagName + (cls ? '.' + cls : '');
};

/** 生成唯一 CSS 路径 */
AIH.cssPath = function (el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w\-]*$/.test(cur.id)) {
      parts.unshift(part + '#' + cur.id);
      break;
    }
    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
    }
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
};

/**
 * 把"某一个消息项"的路径，泛化成"能匹配整组兄弟节点"的选择器。
 * 这是选择器拾取器的核心：用户点一条消息，我们要拿到整列消息。
 */
AIH.generalizeToGroup = function (el) {
  if (!el) return '';
  const parent = el.parentElement;
  if (!parent) return AIH.cssPath(el);

  const sig = AIH.signature(el);
  const sibs = Array.from(parent.children).filter(c => AIH.signature(c) === sig);

  // 兄弟够多 → 用 父路径 > tag.class 的形式，天然匹配整组
  if (sibs.length >= 2) {
    const parentPath = AIH.cssPath(parent);
    let self = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).filter(c => /^[A-Za-z][\w\-]*$/.test(c)).slice(0, 2);
      if (cls.length) self += '.' + cls.join('.');
    }
    return parentPath + ' > ' + self;
  }
  // 兄弟不够 → 往上一层再试（消息项外面常包一层 wrapper）
  if (parent.parentElement) return AIH.generalizeToGroup(parent);
  return AIH.cssPath(el);
};

/** 防抖 */
AIH.debounce = function (fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
};

/** 简单哈希，用于判断对话内容是否变化 */
AIH.hash = function (s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
};

/** 安全取值 */
AIH.pick = function (arr, i, dflt) {
  return (arr && arr.length > i && arr[i] != null) ? arr[i] : dflt;
};
