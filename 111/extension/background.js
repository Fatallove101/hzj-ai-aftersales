/* =====================================================================
   background.js  ·  MV3 Service Worker
   职责：唯一一个负责访问本地服务的角色。

   为什么必须由这里发请求，而不是内容脚本？
   ---------------------------------------------------------------------
   内容脚本里的 fetch 走的是**宿主页面的 Origin**（比如 seller-us.tiktok.com），
   会触发 CORS 预检，而且本地服务必须对任意网站开放跨域 —— 那等于把
   /api/clipboard 这种接口暴露给所有网页，是真实的安全问题。
   由扩展的 Service Worker 发请求，Origin 是 chrome-extension://，
   本地服务就能只放行扩展来源，网页一律拒绝。
   ===================================================================== */

const SERVER = 'http://127.0.0.1:8799';
const TIMEOUT_MS = 30000;

/* ---------------------------------------------------------------------
   独立小窗（Alt+Shift+W）
   有些平台页面禁止脚本注入（严格 CSP），侧边栏根本进不去。
   这时用独立小窗：把本地服务的网页版工作台开成一个浏览器弹窗，
   和平台页面并排摆放即可 —— 不受任何页面 CSP 限制。
   --------------------------------------------------------------------- */
function openStandaloneWindow() {
  try {
    chrome.windows.create({
      url: SERVER + '/#workbench',
      type: 'popup',
      width: 1180,
      height: 860
    });
  } catch (e) {
    console.warn('[售后助手] 打开独立小窗失败：', e);
  }
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-workbench') openStandaloneWindow();
});

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callServer(path, options) {
  const url = SERVER + path;
  let res;
  try {
    res = await fetchWithTimeout(url, options);
  } catch (e) {
    // 请求根本发不出去（CORS / 私有网络 / 被安全软件拦 / 服务没起）
    throw new Error('请求发不出去（' + url + '）：' + ((e && e.message) || e));
  }
  if (!res.ok) {
    // ⚠️ 把响应体也带出来。只看状态码等于白看 ——
    //    服务端的 400 响应体里会写明是哪个分支报的错。
    let body = '';
    try { body = (await res.text() || '').slice(0, 300); } catch (e) { body = '(读响应体失败)'; }
    const hdrs = [];
    try { res.headers.forEach((v, k) => hdrs.push(k + '=' + v)); } catch (e) {}
    throw new Error('本地服务返回 HTTP ' + res.status + ' ' + res.statusText +
                    '  ← ' + url + '\n响应体: ' + (body || '(空)') +
                    '\n响应头: ' + (hdrs.join(' | ') || '(无)'));
  }
  return await res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'health':
          sendResponse({ ok: true, data: await callServer('/api/health') });
          break;

        // ---------- 四种读取源：全部转发给本地服务，扩展这边不重复实现 ----------
        // 服务端 /api/windows /api/uia /api/clipboard /api/ocr 早就写好了，
        // 扩展只是把它们接到界面上。

        case 'windows': {
          // 列出本机可见窗口（读桌面客户端用，如千牛/微信/WhatsApp Desktop）
          const data = await callServer('/api/windows');
          sendResponse({ ok: true, data });
          break;
        }

        case 'uia': {
          // 直读指定窗口的文字（不走 OCR，无识别误差）
          const data = await callServer('/api/uia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload || {})
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'clipboard': {
          // 走服务端读系统剪贴板：不受浏览器剪贴板权限限制，也不弹授权框
          const data = await callServer('/api/clipboard');
          sendResponse({ ok: true, data });
          break;
        }

        case 'ocr-page': {
          // 截当前可见标签页 → 本地 Windows OCR。
          // 比网页版的 getDisplayMedia 好：**不用手动选窗口**，点一下就行。
          // 依赖 activeTab（点扩展图标时授予），所以必须是从面板里触发。
          let dataUrl;
          try {
            const winId = sender && sender.tab ? sender.tab.windowId : null;
            dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
          } catch (e) {
            sendResponse({ ok: false, error: '截屏失败：' + ((e && e.message) || e) +
              '（若提示权限不足，请先点一下扩展图标再试）' });
            break;
          }
          const data = await callServer('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl, country: msg.country || 'UNKNOWN',
                                   platform: msg.platform || 'unknown', category: 'unknown' })
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'knowledge': {
          // GET 读状态；带 payload 则是 POST 保存/测试
          const body = msg.payload && Object.keys(msg.payload).length ? msg.payload : null;
          const data = await callServer('/api/knowledge', body
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : { method: 'GET' });
          sendResponse({ ok: true, data });
          break;
        }

        case 'rules': {
          const rbody = msg.payload && Object.keys(msg.payload).length ? msg.payload : null;
          const rdata = await callServer('/api/custom-rules', rbody
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rbody) }
            : { method: 'GET' });
          sendResponse({ ok: true, data: rdata });
          break;
        }

        case 'retranslate': {
          // 回译：中文（坐席改过的）→ 客户语言，用于"修改后采纳"同步外文
          const data = await callServer('/api/retranslate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload || {})
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'analyze': {
          const data = await callServer('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload || {})
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'feedback': {
          const data = await callServer('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload || {})
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'config-save': {
          // 保存模型配置与 API Key 到本地服务（DPAPI 加密）。
          // Key 只进不出：服务端响应里只有 has_key + 指纹，不会回显密钥。
          const data = await callServer('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload || {})
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'config': {
          // 保存/读取每个站点的选择器配置（存 chrome.storage，不经服务端）
          if (msg.payload && msg.payload.save) {
            const key = 'site:' + msg.payload.host;
            const cur = (await chrome.storage.local.get(key))[key] || {};
            const next = Object.assign({}, cur, msg.payload.save);
            await chrome.storage.local.set({ [key]: next });
            sendResponse({ ok: true, data: next });
          } else {
            const key = 'site:' + (msg.payload && msg.payload.host);
            const cur = (await chrome.storage.local.get(key))[key] || {};
            sendResponse({ ok: true, data: cur });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
      }
    } catch (e) {
      const isNetErr = String(e && e.message || e).indexOf('Failed to fetch') >= 0;
      sendResponse({
        ok: false,
        error: isNetErr
          ? '连不上本地服务。请先双击 111\\启动.bat 启动它（默认 http://127.0.0.1:8799）。'
          : String(e && e.message || e)
      });
    }
  })();
  return true; // 异步响应
});

/* 点击工具栏图标：
   已注入 → 通知内容脚本切换显隐；未注入 → 手动注入（方便在其他平台做测试） */
const CONTENT_FILES = [
  'lib/util.js',
  'lib/extract.js',
  'lib/picker.js',
  'adapters/index.js',
  'adapters/tiktok_shop.js',
  'adapters/amazon.js',
  'adapters/generic.js',
  'content.js'
];

/* 点图标时的短暂角标提示（注入失败时用户能看见，而不是静默无反应） */
function flashBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color || '#ef4444' });
    setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (e) {} }, 2500);
  } catch (e) {}
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const url = tab.url || '';

  // 浏览器内部页面（edge://, chrome://, 扩展商店等）从设计上就不允许注入
  if (/^(edge|chrome|about|devtools|view-source):/i.test(url) ||
      /^https:\/\/microsoftedge\.microsoft\.com\//i.test(url) ||
      /^https:\/\/chromewebstore\.google\.com\//i.test(url)) {
    flashBadge('✕');
    console.warn('[售后助手] 浏览器内部页面无法注入，请在一个普通网页上点击。当前：' + url);
    return;
  }

  try {
    // 已经注入过 → 切换显隐
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) {
    // 没注入过 → 手动注入
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });

      // ⚠️ 这里**绝对不要**再发一次 toggle。
      // content.js 的 boot() 结束时会 setVisible(true)，侧边栏已经显示了；
      // 再 toggle 一次会把它立刻藏回去 —— 表现就是"点了图标没反应"。
      // （这是 v0.1~v0.8 一直存在的一个真 bug，2026-09 修复）
      flashBadge('AI', '#22c55e');
    } catch (e2) {
      flashBadge('!');
      console.warn('[售后助手] 注入失败：', e2);
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[售后助手] 已安装。请确保本地服务已启动：http://127.0.0.1:8799');
});
