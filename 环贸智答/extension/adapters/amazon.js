/* =====================================================================
   adapters/amazon.js  ·  Amazon 卖家中心（Buyer-Seller Messaging）
   
   状态：占位。这一步只搭好结构，等 TikTok Shop 那边验证通过后再补。
   补法：把 Seller Central 消息页的真实 DOM 片段拿来，替换下面的 candidates。
   ===================================================================== */

var AIH = window.AIH || (window.AIH = {});

AIH.AdapterAmazon = {
  id: 'amazon',
  name: 'Amazon 卖家中心',
  verified: false,

  match() {
    return /sellercentral(-europe)?\.amazon\.com$/.test(location.hostname);
  },

  candidates: {
    messageList: [
      '[class*="message-list"]',
      '[class*="messageList"]',
      '[data-testid*="message-list"]',
      '#message-list'
    ],
    messageItem: [
      '[class*="message-item"]',
      '[class*="messageItem"]',
      '[class*="message-bubble"]'
    ],
    inputBox: [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ]
  },

  notes: 'Amazon 买家消息页结构与其他平台差异较大，且分区（.com / -europe）不同。'
};
