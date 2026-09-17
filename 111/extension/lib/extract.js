/* =====================================================================
   lib/extract.js  ·  从页面 DOM 里把"对话"抽出来
   两条路：
     ① 适配器给的选择器能命中 → 用选择器（快、准）
     ② 命中不了 → 自动启发式识别（慢一点，但任何页面都能试）
   ===================================================================== */

const AIH = window.AIH || (window.AIH = {});

/** 一条消息：{ side: 'buyer'|'seller'|'unknown', text: string, el } */
AIH.makeMessage = function (el, side) {
  return { side: side || 'unknown', text: AIH.textOf(el), el: el };
};

/* ---------------------------------------------------------------------
   判断一条消息是谁发的
   优先看 class 线索，其次看几何位置（左=对方，右=自己）
   --------------------------------------------------------------------- */
AIH.detectSide = function (el, container) {
  // ① class / 属性线索
  let node = el, depth = 0;
  while (node && node !== container && depth < 4) {
    const cls = (typeof node.className === 'string' ? node.className : '') + ' ' +
                (node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-e2e') || '') || '');
    if (/left|other|buyer|customer|incoming|receive|them|visitor|guest/i.test(cls)) return 'buyer';
    if (/right|self|seller|outgoing|sent|mine|me\b|agent|service/i.test(cls)) return 'seller';
    node = node.parentElement; depth++;
  }

  // ② 几何位置
  try {
    const box = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (box.width > 40 && r.width > 0) {
      const center = r.left + r.width / 2;
      const rel = (center - box.left) / box.width;
      if (rel < 0.42) return 'buyer';
      if (rel > 0.58) return 'seller';
    }
  } catch (e) {}
  return 'unknown';
};

/* ---------------------------------------------------------------------
   自动寻找"消息列表容器"
   思路：找那个"子元素结构高度重复、且每条都有一定文字量"的元素
   --------------------------------------------------------------------- */
AIH.findMessageList = function (root) {
  const scope = root || document.body;
  if (!scope) return null;

  let best = null, bestScore = 0;
  const all = scope.querySelectorAll('*');
  const LIMIT = 6000;                    // 别在大页面上跑太久
  const end = Math.min(all.length, LIMIT);

  for (let i = 0; i < end; i++) {
    const el = all[i];
    const kids = el.children;
    if (!kids || kids.length < 3 || kids.length > 200) continue;
    if (!AIH.isVisible(el)) continue;

    // 子元素结构是否重复
    const sigCount = {};
    let textSum = 0, texted = 0;
    const sample = Math.min(kids.length, 30);
    for (let j = 0; j < sample; j++) {
      const k = kids[j];
      const sig = AIH.signature(k);
      sigCount[sig] = (sigCount[sig] || 0) + 1;
      const t = AIH.textOf(k);
      if (t.length > 0) { texted++; textSum += t.length; }
    }
    if (texted < 3) continue;

    let maxRepeat = 0;
    for (const s in sigCount) if (sigCount[s] > maxRepeat) maxRepeat = sigCount[s];

    const avgLen = textSum / Math.max(1, texted);
    if (avgLen < 1 || avgLen > 800) continue;         // 太长的不像单条消息
    if (textSum < 20) continue;

    // 打分：重复度为主，文字量为辅
    const score = maxRepeat * 10 + Math.min(textSum / 50, 20) - Math.abs(kids.length - maxRepeat) * 0.5;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
};

/* ---------------------------------------------------------------------
   从消息列表容器里逐条抽消息
   --------------------------------------------------------------------- */
AIH.readList = function (listEl) {
  if (!listEl) return [];
  const kids = Array.from(listEl.children).filter(k => AIH.isVisible(k));

  // 先按"签名分组"，取数量最多的那一组作为消息项
  const groups = {};
  kids.forEach(k => {
    const sig = AIH.signature(k);
    (groups[sig] = groups[sig] || []).push(k);
  });
  let items = [], maxN = 0;
  for (const s in groups) {
    if (groups[s].length > maxN) { maxN = groups[s].length; items = groups[s]; }
  }
  if (items.length < 2) items = kids;

  const msgs = [];
  items.forEach(el => {
    // 消息项内部可能有嵌套结构，取其中文字最长的块，避免把时间戳也算进去
    let target = el, bestLen = AIH.textOf(el).length;
    const inner = el.querySelectorAll('div, p, span');
    for (let i = 0; i < Math.min(inner.length, 12); i++) {
      const t = AIH.textOf(inner[i]);
      if (t.length > 0 && t.length < bestLen && t.length > 4) { target = inner[i]; bestLen = t.length; break; }
    }
    const text = AIH.textOf(target);
    if (!text || text.length < 1) return;
    msgs.push(AIH.makeMessage(el, AIH.detectSide(el, listEl)));
  });
  return msgs;
};

/* ---------------------------------------------------------------------
   找聊天输入框（用于"一键插入"）
   --------------------------------------------------------------------- */
AIH.findInputBox = function () {
  const cands = [];
  AIH.$$('textarea, [contenteditable="true"], [role="textbox"]').forEach(el => {
    if (!AIH.isVisible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 16) return;
    // 靠近屏幕底部、宽度较大的更像聊天输入框
    const score = (r.top / window.innerHeight) * 100 + Math.min(r.width / 20, 40);
    cands.push({ el, score });
  });
  cands.sort((a, b) => b.score - a.score);
  return cands.length ? cands[0].el : null;
};

/* ---------------------------------------------------------------------
   往输入框写文本
   注意：React / Vue 这类框架拦截了 value setter，
   直接 el.value = x 不会触发框架的 onChange，必须用原生 setter + 手动派发事件。
   --------------------------------------------------------------------- */
AIH.insertText = function (el, text) {
  if (!el) return false;
  el.focus();
  const tag = el.tagName;

  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
    el.focus();
    // 先全选再插入，保证替换而非追加
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    return true;
  }
  return false;
};

/* ---------------------------------------------------------------------
   总入口：抽整段对话
   返回 { messages, method, listEl }
   --------------------------------------------------------------------- */
AIH.extractConversation = function (adapter) {
  // ① 适配器选择器
  if (adapter && adapter.selectors) {
    const s = adapter.selectors;
    try {
      if (s.messageList) {
        const list = AIH.$(s.messageList);
        if (list) {
          const msgs = AIH.readList(list);
          if (msgs.length >= 2) return { messages: msgs, method: 'adapter', listEl: list };
        }
      }
      if (s.messageItem) {
        const items = AIH.$$(s.messageItem).filter(AIH.isVisible);
        if (items.length >= 2) {
          const container = items[0].parentElement || document.body;
          const msgs = items.map(el => AIH.makeMessage(el, AIH.detectSide(el, container)))
                            .filter(m => m.text.length > 0);
          if (msgs.length >= 2) return { messages: msgs, method: 'adapter-item', listEl: container };
        }
      }
    } catch (e) { /* 选择器失效，落到自动识别 */ }
  }

  // ② 自动识别
  const list = AIH.findMessageList(document.body);
  if (list) {
    const msgs = AIH.readList(list);
    if (msgs.length >= 2) return { messages: msgs, method: 'auto', listEl: list };
  }
  return { messages: [], method: 'none', listEl: null };
};

/** 把消息数组拼成给本地服务看的纯文本 */
AIH.messagesToText = function (messages, maxTurns) {
  const n = maxTurns || 20;
  const use = messages.slice(-n);
  return use.map(m => {
    const who = m.side === 'buyer' ? 'Buyer' : (m.side === 'seller' ? 'Seller' : 'Msg');
    return who + ': ' + m.text;
  }).join('\n');
};
