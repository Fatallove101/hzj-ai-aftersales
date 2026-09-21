/* =====================================================================
   hzj-ai-aftersales/tools/ext-preview.js
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

function panel(bodyHtml, opts) {
  opts = opts || {};
  const cls = 'panel' + (opts.float ? ' float' : '');
  const h = opts.height || (opts.float ? 620 : 760);
  const w = opts.width || 392;
  const sizes = opts.float
    ? '<span class="szbtns">' +
        '<button class="btn sm on">迷你</button>' +
        '<button class="btn sm">标准</button>' +
        '<button class="btn sm">最大</button>' +
      '</span>'
    : '';
  return `
  <div class="${cls}" style="position:relative;left:0;top:0;right:auto;width:${w}px;height:${h}px;
       border-radius:14px;overflow:hidden;border:1px solid #e3e8f3;box-shadow:0 12px 40px rgba(31,35,41,.18)">
    <div class="hd">
      <div class="logo">AI</div>
      <div class="ttl">跨境销售话术助手</div>
      ${sizes}
      <button class="btn sm" title="切换悬浮/停靠">⇱</button>
      <button class="btn sm">—</button>
    </div>
    <div class="bd" style="height:${h - 96}px">${bodyHtml}</div>
    <div class="ft">
      <span class="dot on"></span>
      <span class="tiny">已连接</span>
      <span style="flex:1"></span>
      ${opts.subView ? '<button class="btn sm" title="返回上一级（Esc）">←</button>' : ''}
      <button class="btn sm">🔑</button>
      <button class="btn sm">⚙</button>
    </div>
  </div>
  <div class="hintlabel">${opts.label || ''}</div>`;
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

/* ---------------- 视图 2：正常工作（三框布局） ---------------- */
function foldClosed(title, badge, inner) {
  return `<div class="card fold closed">
    <div class="foldhd"><span class="foldchev">▶</span><span class="foldttl">${title}</span>${badge ? '<span class="pill i">' + badge + '</span>' : ''}</div>
    <div class="foldbd">${inner || ''}</div>
  </div>`;
}

const mainView = `
<div class="panes" style="height:720px">

  <div class="pane" id="paneChat">
    <div class="pane-hd">
      <span class="pt">客户对话</span><span class="pn">3 条</span>
      <div style="flex:1 0 100%;margin-top:6px">
        <div class="srcbar">
          <button class="srcbtn on">页面</button>
          <button class="srcbtn">剪贴板</button>
          <button class="srcbtn">窗口</button>
          <button class="srcbtn">读屏</button>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn sm">▶ 自动监听</button>
          <button class="btn sm">↻</button>
        </div>
        
      </div>
    </div>
    <div class="pane-bd">
      <div class="chatmsg buyer"><div class="cm-who">客户</div>
        <div class="cm-txt">Guten Tag! Ich habe heute das rote Kleid erhalten, aber die Farbe ist völlig anders als auf Ihren Fotos.</div></div>
      <div class="chatmsg bot"><div class="cm-who">AI客服</div>
        <div class="cm-txt">Es tut mir leid. Ich kann nur eine Anfrage anlegen.</div></div>
      <div class="chatmsg human"><div class="cm-who">人工客服</div>
        <div class="cm-txt">Vielen Dank für Ihre Nachricht, ich kümmere mich darum.</div></div>
      <div style="margin-top:10px">
        <div class="sec">术语对照</div>
        <span class="termchip">Kleid → 连衣裙</span><span class="termchip">Farbe → 颜色</span>
        <div class="tiny" style="margin-top:6px;line-height:1.7">本地演示未接入翻译模型，下方分析基于原文；接上千帆后这里会是整句中文译文（对照翻译）。</div>
      </div>
    </div>
  </div>

  <div class="pane" id="paneCands">
    <div class="pane-hd"><span class="pt">候选话术</span><span class="pn">3 条</span><button class="btn sm pri">换一批</button></div>
    <div class="pane-bd">
      <div class="cand rec">
        <div class="ch"><span class="tag st">安抚致歉</span><span class="tag ok">★ 推荐</span><span class="tag ok">✓ 合规</span></div>
        <div class="cb">We are very sorry the quality issue caused you trouble. This is on us. You may choose a full refund or a replacement, and shipping is covered either way.</div>
        <div class="cb zh">非常抱歉，这件商品的质量问题给您添麻烦了，这是我们的责任。您可以选择全额退款或我们重新补发一件，两种方式的运费都由我们承担。</div>
        <div class="cf"><button class="btn sm pri">⤵ 插入输入框</button><button class="btn sm">📋 复制</button><button class="btn sm">✓ 采纳</button><button class="btn sm">✕</button></div>
      </div>
      <div class="cand">
        <div class="ch"><span class="tag st">专业答疑</span><span class="tag rv">⚠ 需修订</span></div>
        <div class="cb">We are very sorry the quality issue caused you trouble…</div>
        <div class="cb zh">非常抱歉，这件商品的质量问题给您添麻烦了…</div>
        <div class="vio"><b>[R018]</b> 欧盟订单须体现 14 天无理由退货权<br>建议：补充"14 天内可无理由退货"的说明</div>
      </div>
    </div>
  </div>

  <div class="pane" id="paneDetail">
    <div class="pane-hd"><span class="pt">详情</span><span class="pn">点标题展开</span></div>
    <div class="pane-bd">
<div class="card fold closed">
        <div class="foldhd"><span class="foldchev">▶</span><span class="foldttl">读取设置</span></div>
        <div class="foldbd"><div class="row"><select class="sel" style="flex:1"><option>德国</option></select><select class="sel" style="flex:1"><option>英文</option></select></div></div>
      </div>
      ${foldClosed('当前平台', '通用', '<div class="kv"><span>适配器</span><span>通用（自动识别）</span></div>')}
      ${foldClosed('意图 / 情绪 / 紧急度', '质量投诉', '<div class="kv"><span>情绪</span><span>negative / 强度 4</span></div>')}
      ${foldClosed('政策依据', '1 条', '<div class="ev"><div class="evt">西班牙商品瑕疵救济顺位</div><div class="evs">买方主张瑕疵救济时，商家应先修理或更换。</div></div>')}
    </div>
  </div>

</div>`;
/* ---------------- 视图 4：修改后采纳编辑器 ---------------- */
const editView = `
<div class="banner ok"><b>修改后采纳</b><br>改下面的<b>中文</b>，上面的外文会自动重新翻译；确认后直接插入输入框。</div>
<div class="sec">发给客户 · English</div>
<textarea class="rawtext" style="min-height:118px">We are very sorry for any inconvenience. The return policies vary across different platforms. To better assist you, please provide your order number.</textarea>
<div class="tiny" style="margin-top:5px;color:var(--ok)">✓ 外文已同步</div>
<div class="sec" style="margin-top:12px">中文（改这里 · 自动触发回译）</div>
<textarea class="rawtext" style="min-height:130px">非常抱歉给您带来不便，不同平台的退货政策可能有所不同。为了更好地帮助您，请您提供订单号和具体平台，我们会尽快为您核实退货政策并协助处理。</textarea>
<div class="row" style="margin-top:12px">
  <button class="btn pri">⤵ 插入输入框（用外文）</button>
  <button class="btn">📋 复制外文</button>
</div>
<div class="row" style="margin-top:6px">
  <button class="btn">↻ 重新同步</button>
  <button class="btn">仅记录采纳</button>
</div>
<div class="tiny" style="margin-top:8px">原始建议：<br>非常抱歉，这件商品的质量问题给您添麻烦了…</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>扩展面板预览（浅色）</title>
<style>
${pageCss}
body{margin:0;padding:22px;background:#eef2f9;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{display:flex;gap:22px;align-items:flex-start;justify-content:center;flex-wrap:wrap}
.preview-label{font-size:12px;font-weight:700;color:#5b6472;margin:0 0 9px 2px;letter-spacing:.04em}
.hintlabel{font-size:11px;color:#8a919f;margin-top:8px;text-align:center}
</style></head><body>
<div class="wrap">
  <div>
    <div class="preview-label">① 子页面 · 配置 API Key（页脚固定「← 返回」）</div>
    ${panel(setupView, { height: 700, subView: true, label: '子页面也隐藏了"读取源/操作"条；页脚「←」位置固定，Esc 同样可返回' })}
  </div>
  <div>
    <div class="preview-label">② 三框布局：客户对话 / 候选话术 / 详情</div>
    ${panel(mainView, { height: 830 })}
  </div>
  <div>
    <div class="preview-label">③ 修改后采纳 · 改中文则外文自动同步</div>
    ${panel(editView, { height: 830 })}
  </div>
  <div>
    <div class="preview-label">④ 悬浮小窗 · 可拖动 + 三档缩放</div>
    ${panel(mainView, { float: true, width: 372, height: 740, label: '拖住标题栏可移动 · 停靠模式无尺寸按钮' })}
  </div>
</div>
</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT);
console.log('  CSS 取自 extension/content.js（真实样式，非手抄）');
