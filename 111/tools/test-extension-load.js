/* =====================================================================
   111/tools/test-extension-load.js
   扩展内容脚本「共同加载」测试

   为什么需要它（这是踩过的坑）：
     node --check 是**逐文件**做语法检查，测不出跨文件的作用域冲突。
     而浏览器里，同一个扩展的所有 content script 共享一个全局作用域 ——
     每个文件顶层的 `const AIH = ...` 会互相冲突，第二个文件起就抛
     SyntaxError，**整个文件被跳过**。

     症状：AIH 存在（第一个文件注入了），但 AIH.Adapters 是 undefined，
     于是侧边栏初始化时抛 "Cannot read properties of undefined (reading 'detect')"。

     这个 bug 从 v0.1 潜伏到 v0.10，因为一直没把扩展真加载到页面上跑过。

   本测试用 Node 的 vm 模块复现浏览器的共享作用域，把 8 个文件按 manifest
   里的顺序加载进同一个 context，能直接抓到这类问题。

   用法： node tools/test-extension-load.js
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const files = manifest.content_scripts[0].js;

// ---------- 最小 DOM / 扩展 API 打桩 ----------
function makeEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', textContent: '', innerHTML: '', id: '',
    style: new Proxy({}, { get: () => '', set: () => true }),
    children: [], parentElement: null, firstChild: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) {
      // 严格模拟真实 DOM：传 null/undefined 会抛错。
      // 之前这里是 `this.children.push(c)` 无脑收下，于是
      // `body.appendChild(panes.root)` 里 root 为 undefined 这种错**测不出来** ——
      // 结果是用户在浏览器里撞到 "parameter 1 is not of type 'Node'"。
      if (!c || typeof c !== 'object') {
        throw new TypeError("Failed to execute 'appendChild': parameter 1 is not of type 'Node'.");
      }
      this.children.push(c); this.firstChild = this.children[0]; return c;
    },
    insertBefore(c) {
      if (!c || typeof c !== 'object') {
        throw new TypeError("Failed to execute 'insertBefore': parameter 1 is not of type 'Node'.");
      }
      this.children.unshift(c); this.firstChild = this.children[0]; return c;
    },
    removeChild() {}, remove() {}, contains() { return false; },
    addEventListener() {}, removeEventListener() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    attachShadow() { this.shadowRoot = makeShadow(); return this.shadowRoot; },
    isConnected: true, isContentEditable: false, nodeType: 1
  };
  return e;
}
function makeShadow() {
  // 收集子节点，供渲染冒烟测试检查；appendChild 同样严格校验
  const s = {
    children: [],
    appendChild(c) {
      if (!c || typeof c !== 'object') {
        throw new TypeError("Failed to execute 'appendChild': parameter 1 is not of type 'Node'.");
      }
      s.children.push(c);
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }, removeChild() {}
  };
  return s;
}

// 遍历打桩 DOM，收集所有文本（用于检查有没有"渲染失败"横幅）
function collectText(node, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  // ⚠️ 必须跳过 <style>/<script>。
  //    注入的 CSS 里带中文注释（"客户对话""候选话术""详情"…），
  //    不排除的话"三框已挂载"这类断言会永远为真 —— 一个永远通过的断言
  //    比没有断言更糟，它会给出虚假的信心。（真实踩到过。）
  const tn = String(node.tagName || '').toUpperCase();
  if (tn === 'STYLE' || tn === 'SCRIPT') return out;
  if (node.textContent) out.push(String(node.textContent));
  if (node.innerHTML) out.push(String(node.innerHTML));
  if (Array.isArray(node.children)) node.children.forEach((c) => collectText(c, out));
  if (node.shadowRoot) collectText(node.shadowRoot, out);   // Shadow DOM 不在 children 里，要单独走
  return out;
}

const documentStub = {
  // ⚠️ 关键：readyState 设为 loading，让 content.js 只注册监听、不真的跑 boot()。
  //    我们要测的是"文件能不能加载"，不是运行时逻辑。
  readyState: 'loading',
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  createElement: makeEl,
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
  createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {} }; },
  execCommand() { return true; },
  elementFromPoint() { return null; }
};

const context = {
  console: console,
  document: documentStub,
  location: { hostname: 'example.com', protocol: 'https:', pathname: '/', href: 'https://example.com/', hash: '' },
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible', minHeight: '0', marginRight: '' }),
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: (fn) => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  addEventListener: () => {}, removeEventListener: () => {},
  Event: class { constructor(t) { this.type = t; } },
  InputEvent: class { constructor(t) { this.type = t; } },
  HTMLTextAreaElement: function () {}, HTMLInputElement: function () {},
  chrome: {
    runtime: {
      sendMessage: (m, cb) => { if (typeof cb === 'function') cb({ ok: false, error: 'stub' }); },
      onMessage: { addListener() {} }, lastError: null, getURL: (p) => 'chrome-extension://stub/' + p
    },
    storage: { local: {
      // ⚠️ 必须调用回调 —— 扩展代码用的是回调风格。
      //    只返回 Promise 会让 `await new Promise(res => loadUiPrefs(res))` 永远挂起，
      //    于是 bootInner 走不完、render() 根本不执行，渲染冒烟测试就成了空转。
      //    （真实踩到：测试"通过"了，但那个 bug 其实还在。）
      get: (k, cb) => { const v = {}; if (typeof cb === 'function') { cb(v); return; } return Promise.resolve(v); },
      set: (o, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); }
    } },
    tabs: { sendMessage: async () => {} },
    scripting: { executeScript: async () => {} },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }
  }
};
context.window = context;
context.self = context;
context.globalThis = context;

// ---------- 逐个加载（关键：全程用同一个 context）----------
console.log('');
console.log('=== 扩展内容脚本共同加载测试 ===');
console.log('（顺序取自 manifest.json，全部加载进同一个作用域）');
console.log('');

vm.createContext(context);

let failed = 0;
// boot() 里 buildPanel() 在 try 之外 —— 它抛错会变成**静默的未处理 Promise 异常**。
// 不接住的话，渲染冒烟测试会因为"什么都没渲染"而误报通过。
process.on('unhandledRejection', (e) => {
  console.log('  ✕ 未捕获的 Promise 异常：' + ((e && e.message) || e));
  if (e && e.stack) console.log('     ' + String(e.stack).split('\n')[1]);
  failed++;
});
const loaded = [];
for (const f of files) {
  const full = path.join(EXT, f);
  if (!fs.existsSync(full)) {
    console.log('  ✕ ' + f + '  → 文件不存在');
    failed++;
    continue;
  }
  const code = fs.readFileSync(full, 'utf8');
  try {
    vm.runInContext(code, context, { filename: f });
    loaded.push(f);
    console.log('  ✓ ' + f);
  } catch (err) {
    failed++;
    const msg = (err && err.message) || String(err);
    console.log('  ✕ ' + f + '  → ' + msg);
    if (/already been declared/i.test(msg)) {
      console.log('      ↑ 这就是"跨文件重复声明"——浏览器里会导致本文件及其后所有文件被整体跳过');
    }
  }
}

// ---------- 关键符号检查（这才是不加载就发现不了的）----------
console.log('');
console.log('=== 全局符号检查 ===');
const AIH = context.window.AIH;
const checks = [
  ['window.AIH', !!AIH],
  ['AIH.textOf', !!(AIH && AIH.textOf)],
  ['AIH.extractConversation', !!(AIH && AIH.extractConversation)],
  ['AIH.messagesToText', !!(AIH && AIH.messagesToText)],
  ['AIH.Picker.start', !!(AIH && AIH.Picker && AIH.Picker.start)],
  ['AIH.Adapters.detect', !!(AIH && AIH.Adapters && AIH.Adapters.detect)],
  ['AIH.AdapterTikTok', !!(AIH && AIH.AdapterTikTok)],
  ['AIH.AdapterAmazon', !!(AIH && AIH.AdapterAmazon)],
  ['AIH.AdapterGeneric', !!(AIH && AIH.AdapterGeneric)]
];
for (const [name, ok] of checks) {
  if (ok) { console.log('  ✓ ' + name); }
  else { console.log('  ✕ ' + name + '  ← 缺失'); failed++; }
}

// ---------- 适配器能否真的识别 ----------
console.log('');
console.log('=== 适配器识别实测 ===');
if (AIH && AIH.Adapters && AIH.Adapters.detect) {
  const cases = [
    ['seller-us.tiktok.com', 'tiktok_shop'],
    ['sellercentral.amazon.com', 'amazon'],
    ['unknown-site.com', 'generic']
  ];
  for (const [host, expect] of cases) {
    context.location.hostname = host;
    context.location.pathname = '/';
    let got = '(抛异常)';
    try { got = AIH.Adapters.detect().id; } catch (e) { got = '抛出: ' + e.message; }
    const ok = got === expect;
    if (!ok) failed++;
    console.log('  ' + (ok ? '✓' : '✕') + ' ' + host + '  → ' + got + (ok ? '' : '（期望 ' + expect + '）'));
  }
} else {
  console.log('  ✕ AIH.Adapters.detect 不可用，跳过');
  failed++;
}

// ---------- 渲染冒烟测试 ----------
// 为什么必须跑一遍：只检查"符号存在"测不出运行时的 DOM 形状错误。
// 真实踩到的例子：buildPanes() 漏返回 root，renderInner 里
// body.appendChild(panes.root) 拿到 undefined —— 符号检查全过，
// 用户却在浏览器里撞到 "parameter 1 is not of type 'Node'"。
console.log('');
console.log('=== 渲染冒烟测试（直接跑 buildPanel + render）===');
try {
  const T = context.window.AIH && context.window.AIH.__test;
  if (!T) {
    console.log('  ✕ 拿不到 AIH.__test 钩子');
    failed++;
  } else {
    T.buildPanel();
    T.state.adapter = context.window.AIH.Adapters.detect();
    T.state.serverOk = true;                       // 走主路径而不是"连不上"分支
    T.state.messages = [{ side: 'buyer', text: 'Ich möchte das Kleid zurückgeben.' }];
    T.state.lastResult = null;
    T.render();                                    // 无结果路径
    T.renderFooterButtons();

    // 造一份完整的分析结果，再跑一次有结果路径
    T.state.lastResult = {
      trace_id: 'tr_test', input: { country: 'DE' },
      translation: { detected_lang: 'de', translated_text: '', glossary_hits: [{ foreign: 'Kleid', term_zh: '连衣裙' }] },
      analysis: { primary_intent: 'refund', intents: [], emotion: { polarity: 'negative', intensity: 3, signals: [] },
                  urgency: 'high', risk_flags: [], primary_intent_zh: '退款诉求' },
      retrieval: { coverage: 'sufficient', evidence: [{ doc_id: 'DE-BGB-355', title: '撤回权', snippet: '...', score: 0.8, country: 'DE' }] },
      candidates: [{ candidate_id: 'c1', style: '安抚致歉', text_zh: '非常抱歉…', text_en: 'Sorry…', cited_evidence: ['DE-BGB-355'], unsupported: false }],
      compliance: [{ candidate_id: 'c1', style: '安抚致歉', decision: 'pass', violations: [] }],
      routing: { group: '售后组', sla: '4h', source: 'ecommerce-intent-routing' },
      calming: { level: 3, action: '致歉 + 给选项', source: 'customer-reply-craft' },
      skill_application: ['test'],
      meta: { latency_ms: 100, skills: ['after-sales-qa'], composed_prompt_chars: 1000, generated_by: 'local-template', model_used: [] },
      escalation: { need_human: false, reason: '' },
      final: { recommended_candidate_id: 'c1' }
    };
    T.render();
    T.renderFooterButtons();

    // 再跑一遍「修改后采纳」编辑器视图。
    // 为什么必须覆盖：LANG_LABEL 未定义就是这么漏出去的 ——
    // 只测主视图的话，编辑器里的引用错误完全测不到。
    T.state.editCand = T.state.lastResult.candidates[0];
    T.state.editRes = T.state.lastResult;
    T.state.editZh = '测试中文';
    T.state.editTar = 'Test English';
    T.state.view = 'edit';
    T.render();
    T.state.view = 'main';

    // 走一遍点击「✎ 修改后采纳」的入口。
    // 为什么必须覆盖：pickText 未定义就是这么漏的 ——
    // 只测 render() 不测入口函数的话，点击报 ReferenceError 完全测不到。
    T.state.targetLang = 'en';
    T.openEditor(T.state.lastResult.candidates[0], T.state.lastResult);
    T.render();
    T.state.view = 'main';      // 必须复位 —— openEditor 会切到 edit 视图，
    T.state.viewStack = [];     // 不复位的话下面的 render 会在 edit 分支就返回

    // 再跑一遍「生成中」状态（新增的进度分支）
    T.state.busy = true;
    T.state.busySince = Date.now() - 12000;
    T.render();
    const busyTexts = collectText(context.document.documentElement).join('\n');
    if (!busyTexts.includes('正在生成话术')) {
      console.log('  ✕ 「生成中」状态没有渲染出进度提示');
      failed++;
    } else {
      console.log('  ✓ 「生成中」状态渲染正常（含已等待秒数）');
    }
    T.state.busy = false;
    T.state.busySince = 0;
    T.render();

    const texts = collectText(context.document.documentElement).join('\n');
    const bad = [];
    if (texts.includes('渲染失败')) bad.push('renderInner 抛异常（面板出现"渲染失败"横幅）');
    if (texts.includes('初始化失败')) bad.push('bootInner 抛异常（面板出现"初始化失败"横幅）');
    if (bad.length) {
      bad.forEach((b) => { console.log('  ✕ ' + b); failed++; });
      const m = texts.match(/TypeError[^\n]{0,130}/);
      if (m) console.log('     ' + m[0]);
    } else if (texts.length < 20) {
      console.log('  ✕ 渲染后几乎没有任何内容（文本长度 ' + texts.length + '）—— 可能是空转');
      failed++;
    } else {
      // 再断言三个框真的挂上去了。
      // 只查"有没有报错"抓不到"忘把框挂进页面"这类漏挂载（不抛异常，只是没渲染）。
      const need = ['客户对话', '候选话术', '详情', '发给客户'];   // 发给客户 = 编辑器视图渲染成功的标志
      const miss = need.filter((x) => !texts.includes(x));
      if (miss.length) {
        console.log('  ✕ 三个框没挂全，缺少：' + miss.join('、'));
        failed++;
      } else {
        console.log('  ✓ 两条路径渲染无异常；三个框（客户对话/候选话术/详情）均已挂载，产出 ' + texts.length + ' 字符');
      }
    }
  }
} catch (err) {
  console.log('  ✕ 渲染阶段直接抛出：' + ((err && err.message) || err));
  if (err && err.stack) console.log('     ' + String(err.stack).split('\n')[1]);
  failed++;
}
console.log('');
console.log('==============================================');
if (failed === 0) console.log('  全部通过（' + loaded.length + ' 个文件加载成功，9 个符号齐全）');
else console.log('  失败 ' + failed + ' 项');
console.log('==============================================');
process.exit(failed === 0 ? 0 : 1);
