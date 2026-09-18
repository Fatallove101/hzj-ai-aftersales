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
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
    insertBefore(c) { this.children.unshift(c); this.firstChild = this.children[0]; return c; },
    removeChild() {}, remove() {}, contains() { return false; },
    addEventListener() {}, removeEventListener() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    attachShadow() { return makeShadow(); },
    isConnected: true, isContentEditable: false, nodeType: 1
  };
  return e;
}
function makeShadow() {
  return {
    appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }, removeChild() {}
  };
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
    storage: { local: { get: async () => ({}), set: async () => {} } },
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

console.log('');
console.log('==============================================');
if (failed === 0) console.log('  全部通过（' + loaded.length + ' 个文件加载成功，9 个符号齐全）');
else console.log('  失败 ' + failed + ' 项');
console.log('==============================================');
process.exit(failed === 0 ? 0 : 1);
