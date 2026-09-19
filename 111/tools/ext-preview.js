/* =====================================================================
   111/tools/ext-preview.js
   把扩展面板"离屏"渲染成一个静态 HTML，便于截图检查外观。

   为什么需要：扩展面板跑在任意客服页面的 Shadow DOM 里，平时没法直接看。
   本工具直接**复用 content.js 里的真实 CSS**（从模板字符串里抽出来），
   再按真实的 DOM 结构拼一份静态快照，就能用无头浏览器截图检查配色/排版。

   用法： node tools/ext-preview.js   → 生成 samples/ext_preview.html
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const OUT = path.join(__dirname, '..', 'samples', 'ext_preview.html');

const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

// 抽取 const CSS = ` ... `;
const startMark = 'const CSS = `';
const i = src.indexOf(startMark);
if (i < 0) { console.error('没找到 CSS 模板'); process.exit(1); }
const j = src.indexOf('`;', i + startMark.length);
if (j < 0) { console.error('没找到 CSS 结束'); process.exit(1); }
const css = src.slice(i + startMark.length, j);

// Shadow DOM 里的 :host 在预览页换成 :root 才有意义
const pageCss = css.replace(':host{', ':root{').replace('all:initial;', '');

function panel(bodyHtml, footerRight, title) {
  return `
  <div class="panel" style="position:relative;height:760px;border-radius:16px;overflow:hidden;
       box-shadow:0 10px 40px rgba(31,35,41,.16);border:1px solid #e3e8f3">
    <div class="hd">
      <div class="logo">AI</div>
      <div class="ttl">${title}</div>
      <button class="btn sm">—</button>
    </div>
    <div class="bd">${bodyHtml}</div>
    <div class="ft">
      <span class="dot on"></span>
      <span class="tiny">已连接</span>
      <span style="flex:1"></span>
      <button class="btn sm">🔑</button>
      <button class="btn sm">⚙</button>
    </div>
  </div>`;
}

/* ---------------- 视图 1：首次配置（替代登录） ---------------- */
const setupView = `
<div class="setup">
  <div class="setup-hero">
    <div class="big">🧵</div>
    <h3>配置你的 API Key</h3>
    <p>填入你自己的百度千帆 API Key 即可开始使用。<br>Key 用 Windows DPAPI 加密后只存本机，<b>不上传、不回显</b>。</p>
  </div>
  <div class="card">
    <div class="sec">当前状态</div>
    <div class="kv"><span>API Key</span><span><span style="color:var(--warn)">未配置</span></span></div>
    <div class="kv"><span>生效模式</span><span>本地规则引擎</span></div>
  </div>
  <div class="card">
    <div class="sec">填入 API Key</div>
    <label class="fld"><span class="lb">百度千帆 API Key</span>
      <input type="password" value="bce-v3-xxxxxxxxxxxxxxxxxxxx" />
      <div class="hint">控制台 → 千帆 ModelBuilder → 模型服务 → API Key。<span style="color:var(--primary);cursor:pointer">显示明文</span></div>
    </label>
    <label class="fld"><span class="lb">模型名</span><input type="text" placeholder="ernie-4.0-8k-latest" /></label>
    <label class="fld"><span class="lb">接口地址（一般不用改）</span><input type="text" placeholder="https://qianfan.baidubce.com/v2" /></label>
    <div class="row"><button class="btn pri">保存并开始使用</button></div>
    <div class="tiny" style="margin-top:9px"></div>
  </div>
  <div class="card">
    <div class="sec">怎么拿到 API Key</div>
    <ul class="steps">
      <li>登录百度智能云控制台</li>
      <li>进入「千帆 ModelBuilder」→「模型服务」→「API Key」</li>
      <li>新建或复制一个 API Key（形如 bce-v3-...）</li>
      <li>粘贴到上面，点「保存并开始使用」</li>
    </ul>
    <div class="tiny">没有 Key 也能用：系统会走本地规则引擎出话术，只是不调用大模型。<br>随时可从底部 <b>🔑</b> 按钮回到这里配置。</div>
  </div>
</div>`;

/* ---------------- 视图 2：正常工作（浅色） ---------------- */
const mainView = `
<div class="banner ok">✓ 已连接本地服务 http://127.0.0.1:8799</div>
<div class="banner err"><b>⚠ 高风险案件</b>（紧急度极高）<br>回复前请核对下方政策依据，避免口径与该国法规或平台规则冲突。</div>
<div class="card">
  <div class="sec">操作</div>
  <div class="row">
    <button class="btn pri">读取并生成话术</button>
    <button class="btn">▶ 自动监听</button>
    <button class="btn sm">↻</button>
  </div>
  <div class="row" style="margin-top:8px">
    <select class="sel" style="flex:1"><option>西班牙</option></select>
    <select class="sel" style="flex:1"><option>英文</option></select>
  </div>
</div>
<div class="card">
  <div class="sec">当前平台</div>
  <div class="kv"><span>适配器</span><span>通用（自动识别）</span></div>
  <div class="kv"><span>消息区识别</span><span>启发式自动识别</span></div>
  <div class="kv"><span>读取到</span><span>8 条消息</span></div>
</div>
<div class="card">
  <div class="sec">意图 / 情绪 / 紧急度</div>
  <div><span class="pill i">质量投诉 96%</span></div>
  <div class="kv"><span>情绪</span><span>negative / 强度 4</span></div>
  <div class="kv"><span>紧急度</span><span><span style="color:#e5484d">critical</span></span></div>
  <div class="kv"><span>知识覆盖</span><span>sufficient</span></div>
  <div><span class="pill r">平台介入风险</span></div>
</div>
<div class="card">
  <div class="sec">政策依据（1 条）</div>
  <div class="ev">
    <div class="evt">西班牙商品瑕疵救济顺位</div>
    <div class="evs">买方主张瑕疵救济时，商家应先修理或更换；不能履行时可要求减价或解除合同。</div>
    <div class="evm">ES-TRLGDCU-118 · ES · 生效 2014-03-27 · 匹配 0.87</div>
  </div>
</div>
<div class="sec" style="margin:2px 0 8px">候选话术（3 条）</div>
<div class="cand rec">
  <div class="ch"><span class="tag st">安抚致歉</span><span class="tag ok">★ 推荐</span><span class="tag ok">✓ 合规</span></div>
  <div class="cb">We are very sorry the quality issue caused you trouble. This is on us. You may choose a full refund or a replacement, and shipping is covered either way.</div>
  <div class="cb zh">非常抱歉，这件商品的质量问题给您添麻烦了，这是我们的责任。您可以选择全额退款或我们重新补发一件，两种方式的运费都由我们承担。</div>
  <div class="cf"><button class="btn sm pri">⤵ 插入输入框</button><button class="btn sm">📋 复制</button><button class="btn sm">✓ 采纳</button></div>
</div>
<div class="cand">
  <div class="ch"><span class="tag st">专业答疑</span><span class="tag rv">⚠ 需修订</span></div>
  <div class="cb">We are very sorry the quality issue caused you trouble. This is on us…</div>
  <div class="cb zh">非常抱歉，这件商品的质量问题给您添麻烦了…</div>
  <div class="vio"><b>[R018]</b> 欧盟订单须体现 14 天无理由退货权<br>命中：<b>退款</b><br>建议：补充"14 天内可无理由退货"的说明</div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>扩展面板预览（浅色）</title>
<style>
${pageCss}
body{margin:0;padding:22px;background:#eef2f9;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{display:flex;gap:22px;align-items:flex-start;justify-content:center}
.preview-label{font-size:12px;font-weight:700;color:#5b6472;margin:0 0 9px 2px;letter-spacing:.04em}
.panel{width:392px}
</style></head><body>
<div class="wrap">
  <div>
    <div class="preview-label">① 首次使用 · 配置 API Key（替代登录界面）</div>
    ${panel(setupView, '', '跨境售后话术助手')}
  </div>
  <div>
    <div class="preview-label">② 正常工作 · 浅色面板</div>
    ${panel(mainView, '', '跨境售后话术助手')}
  </div>
</div>
</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT);
console.log('  CSS 取自 extension/content.js（真实样式，非手抄）');
