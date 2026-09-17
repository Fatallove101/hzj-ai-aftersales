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
  const res = await fetchWithTimeout(SERVER + path, options);
  if (!res.ok) throw new Error('本地服务返回 HTTP ' + res.status);
  return await res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'health':
          sendResponse({ ok: true, data: await callServer('/api/health') });
          break;

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

        case 'config': {
          // 保存/读取每个站点的选择器配置
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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) {
    // 该页面没有内容脚本（例如不在白名单域名内），手动注入
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
      }, 200);
    } catch (e2) {
      console.warn('[售后助手] 注入失败：', e2);
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[售后助手] 已安装。请确保本地服务已启动：http://127.0.0.1:8799');
});
