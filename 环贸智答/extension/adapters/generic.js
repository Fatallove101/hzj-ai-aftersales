/* =====================================================================
   adapters/generic.js  ·  通用适配器（兜底，匹配任何页面）
   
   没有任何硬编码选择器，完全依赖 extract.js 的启发式识别。
   这也是"手动注入到任意网站做测试"时用的适配器 —— 点扩展图标即可注入。
   ===================================================================== */

var AIH = window.AIH || (window.AIH = {});

AIH.AdapterGeneric = {
  id: 'generic',
  name: '通用（自动识别）',
  verified: true,

  match() { return true; },

  candidates: {
    // 只放极通用的，不做平台假设
    inputBox: [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ]
  },

  notes: '不依赖任何平台特有选择器，用启发式找消息列表。适合新平台接入前先试用。'
};
