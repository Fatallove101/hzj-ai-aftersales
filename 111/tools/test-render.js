/* =====================================================================
   111/tools/test-render.js
   双语话术渲染的单元测试（用 Node 真实执行，不是只看语法）

   为什么需要：浏览器沙箱跑不了，但渲染逻辑是纯函数，
   把依赖打桩后就能在 Node 里真跑一遍，确认：
     · 上层是客户语言、下层是中文
     · 两个块确实分了上下
     · 目标语言缺内容时正确回退并给出提示
     · 不会因为变量改名之类的问题抛异常

   用法： node tools/test-render.js
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

// ---- 从 app.js 里抽出待测代码段 ----
const startMark = 'const LANG_LABEL';
const endMark = 'function renderCandidates';
const s = src.indexOf(startMark);
const e = src.indexOf(endMark);
if (s < 0 || e < 0 || e <= s) {
  console.error('✕ 无法定位待测代码段（LANG_LABEL .. renderCandidates）');
  console.error('  可能 app.js 结构变了，请检查这两个标记是否还在');
  process.exit(1);
}
const extracted = src.slice(s, e);

// ---- 打桩 ----
function makeEl(tag, cls, text) {
  return {
    tag, cls: cls || '', text: text == null ? '' : String(text),
    children: [],
    appendChild(c) { this.children.push(c); return c; }
  };
}
const el = (tag, cls, text) => makeEl(tag, cls, text);
const esc = (x) => String(x == null ? '' : x);
const copied = [];
const copyText = (t) => { copied.push(t); };

let api;
try {
  api = new Function('el', 'esc', 'copyText',
    extracted + '\nreturn { pickText, buildBilingualBlocks, LANG_LABEL };'
  )(el, esc, copyText);
} catch (err) {
  console.error('✕ 待测代码段无法执行：' + err.message);
  process.exit(1);
}

const { pickText, buildBilingualBlocks, LANG_LABEL } = api;

// ---- 用例 ----
const CAND = {
  candidate_id: 'c1',
  style: '安抚致歉',
  text_zh: '非常抱歉，这件商品的质量问题给您添麻烦了。',
  text_en: 'We are very sorry the quality issue caused you trouble.',
  text_es: '',                                   // 故意留空，测回退
  cited_evidence: ['ES-TRLGDCU-118']
};
const CAND_ES = Object.assign({}, CAND, { text_es: 'Lamentamos mucho las molestias.' });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✕ ' + name + (detail ? '  → ' + String(detail) : '')); }
}

// class 可能是 "cand-lang" 也可能是 "cand-lang zh"，必须按词匹配而不是全等
function isLangBlock(b) {
  return typeof b.cls === 'string' && b.cls.split(/\s+/).indexOf('cand-lang') >= 0;
}
function labels(blocks) {
  return blocks.filter(isLangBlock).map(b => (b.children[0].children[0] || {}).text || '');
}
function texts(blocks) {
  return blocks.filter(isLangBlock).map(b => (b.children[1] || {}).text || '');
}
const cnt = (blocks) => blocks.filter(isLangBlock).length;

console.log('');
console.log('=== 双语话术渲染测试 ===');
console.log('');

// 1) 目标语言 = 英文
{
  const blocks = buildBilingualBlocks(CAND, 'en');
  const lb = labels(blocks), tx = texts(blocks);
  console.log('  [目标 en] 块数=' + cnt(blocks) +
              ' 标签=[' + lb.join(' | ') + ']');
  check('产出 2 个语言块（上客户语言 / 下中文）', lb.length === 2, '实际 ' + lb.length);
  check('上层标签标明"发给客户 · English"', /发给客户/.test(lb[0]) && /English/.test(lb[0]), lb[0]);
  check('下层标签为"中文对照"', lb[1] === '中文对照', lb[1]);
  check('上层内容是英文原文', tx[0] === CAND.text_en, tx[0].slice(0, 40));
  check('下层内容是中文译文', tx[1] === CAND.text_zh, tx[1].slice(0, 40));
  check('上层在下层之前（上下分割顺序正确）', tx[0] === CAND.text_en && tx[1] === CAND.text_zh);
}

// 2) 目标语言 = 西语，但候选没有西语 → 应回退英文并给提示
{
  const blocks = buildBilingualBlocks(CAND, 'es');
  const lb = labels(blocks), tx = texts(blocks);
  const note = blocks.find(b => b.cls === 'lang-note');
  console.log('  [目标 es·缺西语] 标签=[' + lb.join(' | ') + '] 有提示=' + !!note);
  check('仍然产出 2 个语言块', lb.length === 2, '实际 ' + lb.length);
  check('上层标签标明 Español', /Español/.test(lb[0]), lb[0]);
  check('内容回退为英文', tx[0] === CAND.text_en);
  check('给出回退提示', !!note && /回退|代替|暂以/.test(note.text), note && note.text);
}

// 3) 目标语言 = 西语，且有西语 → 直接用西语，不出提示
{
  const blocks = buildBilingualBlocks(CAND_ES, 'es');
  const tx = texts(blocks);
  const note = blocks.find(b => b.cls === 'lang-note');
  console.log('  [目标 es·有西语] 上层=' + tx[0].slice(0, 32));
  check('上层用西语原文', tx[0] === CAND_ES.text_es);
  check('下层仍是中文', tx[1] === CAND_ES.text_zh);
  check('不出现回退提示', !note);
}

// 4) 目标语言 = 中文 → 只有一个块，不重复显示
{
  const blocks = buildBilingualBlocks(CAND, 'zh');
  const lb = labels(blocks);
  console.log('  [目标 zh] 块数=' + lb.length + ' 标签=[' + lb.join(' | ') + ']');
  check('只产出 1 个块（避免中文重复两遍）', lb.length === 1, '实际 ' + lb.length);
  check('内容为中文', texts(blocks)[0] === CAND.text_zh);
}

// 5) 每块都有独立复制按钮，且复制的是本块内容
{
  copied.length = 0;
  const blocks = buildBilingualBlocks(CAND, 'en');
  const btns = blocks.filter(isLangBlock)
    .map(b => (b.children[0].children || []).find(x => x.cls && x.cls.indexOf('xs') >= 0));
  check('每个语言块各有一个复制按钮', btns.length === 2 && btns.every(Boolean));
  if (btns[0] && btns[0].onclick) btns[0].onclick();
  if (btns[1] && btns[1].onclick) btns[1].onclick();
  check('上块复制英文', copied[0] === CAND.text_en, String(copied[0]).slice(0, 40));
  check('下块复制中文', copied[1] === CAND.text_zh, String(copied[1]).slice(0, 40));
}

// 6) pickText 边界
{
  check('pickText(zh) 返回中文', pickText(CAND, 'zh').text === CAND.text_zh);
  check('pickText(en) 返回英文', pickText(CAND, 'en').text === CAND.text_en);
  check('pickText(未知语言) 不崩且返回英文', pickText(CAND, 'xx').text === CAND.text_en);
  check('LANG_LABEL 三种语言齐全', !!(LANG_LABEL.en && LANG_LABEL.es && LANG_LABEL.zh));
}

console.log('');
console.log('==============================================');
if (fail === 0) console.log('  全部通过  (' + pass + ' 项)');
else console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('==============================================');
process.exit(fail === 0 ? 0 : 1);
