/* =====================================================================
   adapters/index.js  ·  平台适配器注册表
   
   设计：每个平台一个适配器文件，只描述"这个平台的 DOM 长什么样"。
   新增平台 = 加一个文件 + 在下面注册，其余代码一行不用改。
   选择器失效时不影响使用：会自动退到启发式识别，用户也能用拾取器重学。
   ===================================================================== */

var AIH = window.AIH || (window.AIH = {});

AIH.Adapters = (function () {

  function all() {
    const list = [];
    if (AIH.AdapterTikTok) list.push(AIH.AdapterTikTok);
    if (AIH.AdapterAmazon) list.push(AIH.AdapterAmazon);
    if (AIH.AdapterGeneric) list.push(AIH.AdapterGeneric);
    return list;
  }

  /** 当前页面该用哪个适配器 */
  function detect() {
    for (const a of all()) {
      try { if (a.match && a.match()) return a; } catch (e) {}
    }
    return AIH.AdapterGeneric;
  }

  /** 从候选选择器里挑出当前页面真正命中的那个 */
  function resolveSelectors(adapter, overrides) {
    const out = {};
    const src = Object.assign({}, (adapter && adapter.candidates) || {});
    // 用户用拾取器学到的选择器优先级最高
    if (overrides) {
      for (const k in overrides) if (overrides[k]) src[k] = [overrides[k]].concat(src[k] || []);
    }
    for (const key in src) {
      const list = Array.isArray(src[key]) ? src[key] : [src[key]];
      for (const sel of list) {
        if (!sel) continue;
        try {
          if (document.querySelector(sel)) { out[key] = sel; break; }
        } catch (e) { /* 非法选择器，跳过 */ }
      }
    }
    return out;
  }

  return { all, detect, resolveSelectors };
})();
