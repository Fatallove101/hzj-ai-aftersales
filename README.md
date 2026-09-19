# 汉正街跨境售后 AI 话术助手

面向武汉汉正街服装跨境商户的**多语言售后话术助手**，基于百度千帆构建。

---

## ⚠️ 先说清楚定位（很重要，别理解错）

本工具 **不是「AI 客服」**，也 **不是**"AI 答不了就转人工"。

真实业务链路是：

```
别的 AI 客服先接待 → 解决不了转人工 → 人工坐席用本工具生成话术 → 人工确认后回复客户
                                          ↑ 我们在这里
```

所以：

- **我们的用户是坐在工位上的人工客服**，不是终端消费者
- **我们的产出是给人工用的话术建议**，工具**永远不直接给客户发消息**
- 界面上没有"建议转人工"，只有「**⚠ 高风险案件 · 回复前请核实**」
- 对话里会混着**前面 AI 客服说过的话**，必须分得清（否则人工会和 AI 自相矛盾）
- **"符合当地政策"是核心卖点** —— 政策依据面板和分析面板同级突出

---

## 仓库里有什么

| 目录 | 是什么 | 入口 |
|---|---|---|
| `agent设计/` | 完整设计方案：1 主控 + 6 子 Agent 架构、7 份系统提示词、JSON Schema、知识库/数据库/合规规则库设计、千帆搭建手册、评测运营方案 | [`agent设计/00-交付总览.md`](agent设计/00-交付总览.md) |
| `hzj-ai-aftersales/` | **可运行的本地演示**（后端 + 网页版） | [`hzj-ai-aftersales/README.md`](hzj-ai-aftersales/README.md) |
| `hzj-ai-aftersales/extension/` | **浏览器扩展**：在客服后台右侧挂侧边栏，读对话 → 出话术 → 一键插入输入框 | [`hzj-ai-aftersales/extension/README.md`](hzj-ai-aftersales/extension/README.md) |
| `222/` | 早期参考素材 | — |

原始需求文档：`汉正街跨境售后AI话术助手——基于百度千帆的多语言客服能力提升系统项目申报书(2).docx`

---

## 30 秒跑起来

**双击 `hzj-ai-aftersales\启动.bat`**，浏览器会自动打开 <http://127.0.0.1:8799/>

**零依赖**：不需要 Python、Node，也不需要管理员权限。
只用系统自带的 PowerShell 5.1 + Windows 内置 OCR。

> 默认是**纯本地规则引擎**（`provider: local`），**不发起任何外部请求**。
> 接千帆见下方「接上千帆模型」。

---

## 装浏览器扩展（3 分钟）

1. 打开 `edge://extensions/`（Chrome 用 `chrome://extensions/`）
2. 打开「**开发人员模式**」
3. 点「**加载解压缩的扩展**」，选 `hzj-ai-aftersales\extension` 目录
4. 打开客服后台页面，右上角出现 **AI 悬浮球**，点开即用

**首次使用要校准一次**（30 秒）：
点页脚 **⌖**（准星）→ 分别拾取「消息区容器」和「回复输入框」→ 选择器只存在本机浏览器里。

**页脚按钮**：`←` 返回 ／ `🔑` API Key ／ `⌖` 重新拾取选择器 ／ `⚙` 设置

---

## 核心功能

### 五种读取对话的方式

| 按钮 | 原理 | 适用 |
|---|---|---|
| **页面** | 直读网页 DOM | 普通网页，**100% 精确，首选** |
| **剪贴板** | 读系统剪贴板 | 任何软件里选中文字 `Ctrl+C` 后点它 |
| **窗口** | UI Automation 直读窗口文字 | 桌面客户端（**不走 OCR，无识别误差**） |
| **读屏** | 截图 + Windows OCR | DOM 读不到时（Canvas 自绘界面、图片里的字） |
| **手动** | 自己粘贴 / 输入 | 任何来源：第三方系统、抄来的、口头转述 |

**页面 vs 读屏是互补的，不是重复的**：页面准但只能读网页；读屏有误差但**任何界面都能用**。
微信文件传输助手那种自绘界面，DOM 读不到，只能靠读屏。

### 三框工作台

| 框 | 内容 |
|---|---|
| **① 客户对话** | 按说话人分色的对话气泡（客户/AI客服/人工客服）+ 中文对照；读取源按钮都在这个框的标题栏 |
| **② 候选话术** | ≤3 条候选，中外双语，带合规标记；「**换一批**」重新生成 |
| **③ 详情** | 读取设置（国家/回复语言）、当前平台、意图情绪、政策依据、命中技能（可折叠） |

### 其它

- **理解客户**：14 类意图识别、情绪强度、紧急度分级、风险标记
- **检索知识**：20 条各国政策（ALL/EU/US/DE/ES/GB/AU/FR/IT/JP）+ 46 条服装跨境术语，按国家/平台/生效日期过滤
- **生成话术**：≤3 条候选，五种风格（安抚致歉 / 专业答疑 / 营销促单 / 纠纷调解 / 合规告知）
- **合规闸门**：真实执行 30 条规则的正则校验，`reject` 的话术**永不进入最终输出**
- **修改后采纳**：改中文 → **外文自动重新翻译** → 直接插入输入框（保证内外记录一致）
- **高风险判定**：命中平台介入 / 拒付 / 法律风险 / 知识无依据等条件时强制标高风险
- **数据闭环**：采纳 / 修改 / 忽略写回日志，统计采纳率与人工修改幅度
- **设置页**：生效模式、知识源（本地 CSV / 千帆）、自定义禁用表述（含误杀预警）
- **API Key 安全**：DPAPI 加密存储、接口永不回显、不进 git
- **日志脱敏**：请求体落盘前过 `Protect-LogBody` —— 密钥类字段整值抹掉、
  正文类字段只留长度不留内容、任何 `bce-v3/` 串一律打码
  > ⚠️ **v0.33.0 之前这条是假的**：`Write-ReqLog` 会把原始请求体整行写进
  > `hzj-ai-aftersales\logs\requests.log`，保存密钥那次请求把**密钥明文**落了盘，
  > 分析请求还把**客户对话原文**落了盘（实测 118 行）。
  > 已修 + 已删除存量日志。详见 CHANGELOG 或 commit `v0.33.0`。

---

## 接上千帆模型

### 1. 复制配置

```powershell
cd 111
copy config.example.json config.local.json
```

编辑 `config.local.json`：

```json
{
  "model": {
    "provider": "qianfan",
    "endpoint": "https://qianfan.baidubce.com/v2",
    "model": "ernie-4.5-turbo-128k",
    "timeout": 90
  }
}
```

> **`endpoint` 填基址即可**，代码会自动补 `/chat/completions`。
> 填完整路径也能用（见 `engine/llm.ps1` 的 `Resolve-ChatUrl`）。

### 2. 存密钥

```powershell
powershell -ExecutionPolicy Bypass -File tools\set-api-key.ps1
```

密钥用 **Windows DPAPI（CurrentUser）加密**后存到
`%APPDATA%\hzj-agent\credential.dat`，**明文不落盘、不进 git、接口永不回显**
（只返回 `has_key` 和一个 8 位 SHA256 指纹）。

也可以在扩展设置页 ⚙ 或网页版「设置」里直接填。

### 3. 核对请求形状

```powershell
powershell -ExecutionPolicy Bypass -File tools\test-model.ps1 -DryRun
```

只打印请求体形状，**不发请求、不打印密钥**。确认无误后再去掉 `-DryRun` 真发一次。

### 4. 重启服务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 -Port 8799
```

扩展页脚会显示 🟢 已连接，设置页 ⚙ →「生效模式」会显示**外部模型**。

---

### 接千帆时踩过的坑（都已在代码里修掉，但值得知道）

| 现象 | 原因 |
|---|---|
| `404 ResourceNotFound` | `endpoint` 少了 `/chat/completions`。已加 `Resolve-ChatUrl` 自动补齐 |
| `account_overdue` | 该模型是付费的且账号欠费。实测 `ernie-4.5-turbo-128k` 可用 |
| `invalid_model` | 模型名不对。千帆 v2 接口的可用列表**与控制台不完全一致**，以实测为准 |
| 模型明明返回了 JSON，界面却还是本地模板 | 模型**用 ` ```json ` 代码块包住了**，而解析只认首字符 `{`。已加 `ConvertFrom-ModelJson` 剥代码块 |
| 界面完全看不出模型没被调用 | 调用失败被 `catch` 降级成"本地模板"且不显示原因。已改为错误里带 URL + 千帆返回的 code |

**单次分析约 20~40 秒**（翻译 + 生成两轮）。这是模型本身的延迟：
实测 generate 调用 27 秒、completion 仅 731 token，`max_tokens` 调小不会变快
（调到 600 反而把 JSON 截断）。扩展里已加**实时等待秒数**提示。

---

## 验证（改完东西一定要跑）

```powershell
cd 111

# 所有 .ps1 必须带 UTF-8 BOM（PS 5.1 否则按 GBK 解码 → 中文全乱 → 语法错）
powershell -File tools\check-bom.ps1

# 后端逻辑自检（约 11 秒）
# **默认强制走本地规则引擎，不真调模型** —— 测试要确定性、免费、快。
# 它会跑 7 个完整行为用例；接上模型后如果真发请求，这条要 227 秒且结果不确定。
# 想连模型一起验：加 -UseModel
powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1

# JS 语法 —— 用 Node 真解析（最准；Node 不在 PATH 时用完整路径）
node --check extension\content.js
node --check extension\background.js

# 扩展 JS 结构校验 —— **无 Node 环境的兜底方案**（状态机扫括号/字符串/注释闭合）
# 有 Node 时用上面的 node --check 更准，这条只是双保险
powershell -ExecutionPolicy Bypass -File tools\check-js.ps1

# 扩展：共同作用域加载 + 渲染冒烟 + 视图路由 + CSS class 完整性
node tools\test-extension-load.js

# 扩展与后端的请求契约
node tools\test-extension-contract.js

# 前端渲染逻辑单元测试（22 项）
node tools\test-render.js

# 布局：无头浏览器真实测量
powershell -ExecutionPolicy Bypass -File tools\layout-check.ps1 -Width 1500 -Height 940
```

**八项全绿才算通过。** 完整跑一遍约 1~2 分钟
（最慢的是 `selfcheck` 的 126 条模板自检和无头浏览器的布局实测）。

> `selfcheck` 与 `test-extension-contract.js` 里的端到端检查**都会真的发请求**，
> 但 `selfcheck` 默认强制走本地（`Set-LlmForceLocal`），
> 只有加 `-UseModel` 才连模型 —— 避免"跑个测试又慢又花钱"。

### 这八项分别是

| # | 检查 | 覆盖 |
|---|---|---|
| 1 | `check-bom.ps1` | 所有 `.ps1` 带 UTF-8 BOM（PS 5.1 的硬性要求） |
| 2 | `test-extension-load.js` | 共同作用域加载 + **渲染冒烟** + **视图路由** + **CSS class 完整性** |
| 3 | `test-extension-contract.js` | 扩展与后端的请求体契约（含"多包一层 payload"会 400 的验证） |
| 4 | `test-render.js` | 前端渲染逻辑单元测试 22 项 |
| 5 | `check-js.ps1` | JS 结构校验（无 Node 兜底） |
| 6 | `node --check` | 所有 JS 真语法解析 |
| 7 | `selfcheck.ps1` | 后端行为用例 + 合规闸门单元测试（默认强制本地，不调模型） |
| 8 | `layout-check.ps1` | 无头浏览器真实测量布局 |

### 几个检查是"被 bug 教出来的"

这几个检查的注释里都写了它们抓到过的真实 bug，别删：

- **渲染冒烟测试**：真的跑 `buildPanel + render`，检查面板里有没有「渲染失败」横幅。
  抓到过 `buildPanes()` 漏返回 `root` 导致整个主界面白屏。
- **视图路由完整性**：每个 `pushView('X')` 必须有对应的 `state.view === 'X'` 分支。
  抓到过 `pushView('picker')` 没有分支 → 点 ⌖ 落回主页。
- **CSS class 完整性**：JS 里 `class:'X'` 用到的，CSS 里必须有定义。
  抓到过 `.rawtext`（文本框样式全丢）和 `.ruleitem`。
- **这两条检查自己都踩过"没剥注释"的坑** —— 注释里提到的名字被当成真实定义，
  导致检查给假通过。**扫源码的检查必须先剥注释**。

---

## 生成预览图（不装扩展也能看界面）

```powershell
node tools\ext-preview.js
# 生成 samples\ext_preview.html，用浏览器打开
```

CSS 直接从 `extension/content.js` 提取（真实样式，非手抄），
包含 4 个视图：配置页 / 三框主界面 / 修改后采纳编辑器 / 悬浮小窗。

---

## 已知限制（有意为之，不是 bug）

- **合规规则库是 `seed` 数据，标注"待法务确认"** —— 这是**工程数据，不是法律意见**。
  上线前必须经法务逐条核对。同理 `policy_index.csv`。
- **千帆知识库路径尚未对接真实接口** —— 契约已定义（见
  [`hzj-ai-aftersales/docs/接入千帆知识库.md`](hzj-ai-aftersales/docs/接入千帆知识库.md)），
  字段名不同只需改 `engine/knowledge.ps1` 的映射。当前会**显式降级到本地 CSV** 并说明原因。
- **TikTok Shop 的选择器未在真实后台验证**（没有账号），需实机校准一次。
- **本地模式的翻译只有术语级对照**，整句译文需要模型。
  界面会**明确说明为什么没有整句译文，不伪造翻译**。
- **扩展只在 Edge / Chrome 测过**（MV3）。

---

## 安全设计

- **API Key**：Windows DPAPI 加密，只存本机，接口永不回显，不进日志，`config.local.json` 已 gitignore
- **本地服务 CORS 白名单**：只放行 `chrome-extension://` 来源 + 本机页面，
  任意网站读不到剪贴板/窗口文字
- **扩展通过 Service Worker 发请求**（不在 content script 里直连），
  这样服务端才能按扩展来源做白名单
- **合规闸门在服务端执行**：`reject` 的话术不返回给前端，不是靠前端自觉

---

## 目录速查

```
hzj-ai-aftersales/
├─ server.ps1              # 本地 HTTP 服务（TcpListener，端口 8799）
├─ 启动.bat                # 双击启动
├─ engine/                 # 后端逻辑
│  ├─ pipeline.ps1         #   7-Agent 管线（主流程）
│  ├─ llm.ps1              #   模型调用 + 密钥管理 + 提示词展开
│  ├─ rules.ps1            #   知识库加载 + 合规正则校验 + 自定义规则
│  ├─ knowledge.ps1        #   知识源抽象（local / qianfan）
│  ├─ skills.ps1           #   技能加载与注入
│  ├─ reader.ps1 / ocr.ps1 #   窗口直读 / 读屏 OCR
│  └─ metrics.ps1          #   相似度（算人工修改幅度）
├─ data/                   # 知识库与规则（CSV/JSONL）
├─ prompts/                # 7 份 Agent 系统提示词（Markdown）
├─ skills/                 # 6 个技能（Markdown）
├─ extension/              # 浏览器扩展（MV3）
├─ web/                    # 网页版工作台
├─ tools/                  # 自检与测试工具
├─ docs/                   # 补充文档
└─ samples/                # 截图与预览
```

### API 一览（17 个）

`/api/health` `/api/analyze` `/api/feedback` `/api/stats` `/api/audit`
`/api/rules` `/api/custom-rules` `/api/skills` `/api/prompt-preview`
`/api/config` `/api/model-status` `/api/knowledge` `/api/retranslate`
`/api/windows` `/api/uia` `/api/clipboard` `/api/ocr`

---

## 改代码前必读

1. **所有 `.ps1` 必须存成 UTF-8 with BOM**。PowerShell 5.1 没有 BOM 就按 GBK 解码，
   中文变乱码 → 引号断裂 → 语法错。用 `tools\check-bom.ps1` 检查。
2. **别用 `\"` 转义双引号** —— PowerShell 里不合法。用单引号 here-string（`@'...'@`）。
3. **`Contains()` 做插入锚点不可靠** —— 用精确锚点或行号，
   并**确认替换真的生效**（打印替换前后的行数/内容）。
4. **改完一定跑全量自检**，尤其是渲染冒烟和路由检查。
5. **反向验证**：新加一条检查后，故意把 bug 还原回去，确认检查**真的会失败**。
   不会失败的检查比没有检查更糟 —— 它给虚假的信心。

---

## 下一步

- 真实场景测试（需要客服后台账号校准选择器）
- 合规规则库送法务逐条确认
- 千帆知识库路径对接真实接口
- 模型响应提速（精简提示词 / 并行调用翻译与生成）
