/* =====================================================================
   adapters/tiktok_shop.js  ·  TikTok Shop 商家后台（首选测试平台）

   ⚠️ 重要说明（必读）
   ---------------------------------------------------------------------
   下面这些选择器是**按常见 React 后台结构推测的候选值，未在真实站点验证过**。
   原因：登录态页面我无法访问。

   失效也没关系，本扩展有三层兜底，按顺序生效：
     ① 适配器选择器命中 → 最快最准
     ② 启发式自动识别（extract.js 里的 findMessageList）→ 通常也能用
     ③ 用户用"拾取器"点一下消息区 → 学到选择器存进 chrome.storage，
        之后优先级最高，且平台改版后重新点一次即可

   所以：你不需要给我 DOM 也能先用起来。
   如果想让第①层也可靠，把真实 DOM 片段发我，我把这里换成准确选择器。
   ===================================================================== */

var AIH = window.AIH || (window.AIH = {});

AIH.AdapterTikTok = {
  id: 'tiktok_shop',
  name: 'TikTok Shop 商家后台',
  verified: false,          // 选择器未经真实验证

  match() {
    const h = location.hostname;
    const p = location.pathname + location.hash;
    if (!/tiktok\.com$|tiktokglobalshop\.com$/.test(h)) return false;
    // 商家后台常见路径特征
    return /seller|sellercenter/i.test(h) || /chat|message|im\b|conversation|order/i.test(p);
  },

  candidates: {
    messageList: [
      '[class*="message-list"]',
      '[class*="messageList"]',
      '[class*="chat-list"]',
      '[class*="chatList"]',
      '[class*="conversation-list"]',
      '[class*="conversationList"]',
      '[class*="session-list"]',
      '[data-e2e*="message-list"]',
      '[data-tux-component*="message"]'
    ],
    messageItem: [
      '[class*="message-item"]',
      '[class*="messageItem"]',
      '[class*="msg-item"]',
      '[class*="chat-item"]',
      '[class*="bubble"]',
      '[data-e2e*="message-item"]'
    ],
    inputBox: [
      '[class*="chat"] textarea',
      '[class*="message"] textarea',
      '[class*="editor"] textarea',
      '[class*="input"] textarea',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ]
  },

  notes:
    'TikTok Shop 商家后台是 React SPA，路由切换不会刷新页面。' +
    '扩展用 MutationObserver 监听 DOM 变化并在路由切换后重新适配。'
};
