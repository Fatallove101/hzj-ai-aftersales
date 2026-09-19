/* =====================================================================
   111/tools/test-extension-contract.js
   扩展 ↔ 本地服务 的「请求契约」测试

   为什么需要它（这是踩过的坑）：
     content.js 的 msg(type, payload) 内部**已经**把第二个参数包成 { payload }：
         chrome.runtime.sendMessage({ type, payload })
     background.js 收到后再 JSON.stringify(msg.payload) 发给服务端。

     但调用方又手写了一次 { payload: {...} }，于是变成双重包装：
         {"payload": {"text": "...", ...}}
     而服务端读的是顶层 $b.text → 永远是 null → 400 "text 不能为空"。

     症状极具误导性：界面报"连不上本地服务"，实际连接完全正常。
     这个 bug 从 v0.1 潜伏到 v0.14，因为 analyze / config 两个功能从没真正跑通过。

   node --check 测不出这类问题 —— 它只查语法，不查跨文件的请求契约。

   用法： node tools/test-extension-contract.js
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');

const EXT = path.join(__dirname, '..', 'extension');
const content = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let failed = 0;
function ok(name) { console.log('  ✓ ' + name); }
function bad(name, detail) { console.log('  ✕ ' + name + (detail ? '  → ' + detail : '')); failed++; }

console.log('');
console.log('=== 1) 静态检查：msg() 调用是否重复包装 payload ===');
// msg(type, payload) 已经包了一层，调用方不能再传 { payload: ... }
const calls = [];
// ⚠️ 字符类必须包含连字符：消息类型叫 'config-save'，
//    写成 [a-zA-Z_]+ 会漏掉它，测试就出现盲区（自己踩过）。
const re = /msg\(\s*'([a-zA-Z_-]+)'\s*,\s*\{/g;
let m;
while ((m = re.exec(content)) !== null) {
  // 取该调用起点后的一小段，看紧跟的键名
  const after = content.slice(m.index + m[0].length - 1, m.index + m[0].length + 30);
  calls.push({ type: m[1], after: after.replace(/\s+/g, ' '), at: content.slice(0, m.index).split('\n').length });
}
if (calls.length === 0) {
  bad('没有找到任何 msg() 调用，检查正则是否失效');
} else {
  let dup = 0;
  for (const c of calls) {
    if (/^\{\s*payload\s*:/.test(c.after)) {
      bad(`msg('${c.type}', ...) 第 ${c.at} 行重复包装了 payload`);
      dup++;
    }
  }
  if (dup === 0) ok(`${calls.length} 处 msg() 调用都没有重复包装 payload`);
}

console.log('');
console.log('=== 2) 检查 msg() 的实现（确认它确实会包一层）===');
if (/sendMessage\(\s*Object\.assign\(\s*\{\s*type\s*\}/.test(content)) {
  ok('msg() 内部会包成 { type, payload }  —— 所以调用方不能再包');
} else {
  bad('msg() 的实现变了，本测试的前提需要复核');
}

console.log('');
console.log('=== 3) 端到端：用扩展的真实请求形状打服务端 ===');
const PORT = 8799;
const HOST = '127.0.0.1';

function post(pathname, obj) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: HOST, port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length,
                 'Origin': 'chrome-extension://ehjgdemfbjplbabnkljhofhmhemfjmhe' },
      timeout: 8000
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

(async () => {
  // 先探活
  const alive = await new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/health', timeout: 4000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  if (!alive) {
    console.log('  ⚠ 本地服务没在跑（' + HOST + ':' + PORT + '），跳过端到端检查');
    console.log('    启动方式：111\\启动.bat');
  } else {
    // 正确形状：content.js 传 {text,country,platform,category}
    //   → msg() 包成 {type:'analyze', payload:{text,...}}
    //   → background 发 msg.payload
    const good = { text: 'Buyer: The dress arrived with stains\nSeller: So sorry, let me check',
                   country: 'DE', platform: 'amazon', category: 'dress' };
    const r1 = await post('/api/analyze', good);
    if (r1.status === 200) ok('正确的扁平形状 → HTTP 200');
    else bad('正确的扁平形状竟然不是 200', 'HTTP ' + r1.status + ' ' + r1.body.slice(0, 120));

    // 错误形状（这次踩的坑）：多包一层 payload
    const wrong = { payload: good };
    const r2 = await post('/api/analyze', wrong);
    if (r2.status === 400) ok('多包一层 payload → 400（服务端确实会拒，说明这个坑是真的）');
    else console.log('  · 多包一层 payload → HTTP ' + r2.status + '（服务端行为变化，请复核）');

    // 空文本
    const r3 = await post('/api/analyze', { text: '', country: 'DE' });
    if (r3.status === 400) ok('空文本 → 400（客户端必须提前拦住）');
    else bad('空文本竟然通过了', 'HTTP ' + r3.status);
  }

  console.log('');
  console.log('==============================================');
  if (failed === 0) console.log('  全部通过');
  else console.log('  失败 ' + failed + ' 项');
  console.log('==============================================');
  process.exit(failed === 0 ? 0 : 1);
})();
