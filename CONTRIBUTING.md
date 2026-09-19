# 协作指南（CONTRIBUTING）

欢迎一起改。这个项目有一些**不写下来一定会踩的坑**，动手前请先花 3 分钟读完本文。

---

## 一、这是什么项目

面向武汉汉正街服装跨境商户的多语言售后话术助手。两部分：

| 目录 | 内容 | 入口 |
|---|---|---|
| `agent设计/` | 设计方案：1 主控 + 6 子 Agent、7 份提示词、JSON Schema、知识库/数据库/合规规则库、千帆搭建手册、评测方案 | `agent设计/00-交付总览.md` |
| `hzj-ai-aftersales/` | 可运行的本地演示（Web 工作台） | `hzj-ai-aftersales/README.md` |
| `hzj-ai-aftersales/extension/` | 浏览器扩展原型（TikTok Shop 侧边栏） | `hzj-ai-aftersales/extension/README.md` |

---

## 二、环境要求

| 需要 | 用途 | 必需？ |
|---|---|---|
| **Windows** | 演示依赖 Windows 内置 OCR（`Windows.Media.Ocr`）与 UI Automation | 是 |
| **PowerShell 5.1** | 系统自带，后端就是它 | 是 |
| **Edge 或 Chrome** | 跑工作台界面 / 加载扩展 | 是 |
| **Node.js** | JS 语法校验、渲染单元测试 | 建议（没有也能跑，但有自检跑不了） |
| Python / npm 包 | **不需要** | — |

> 后端**零第三方依赖**：只用 .NET 标准库。不要为了"方便"引入 NuGet/npm 依赖。

---

## 三、跑起来

```powershell
# 启动本地演示（双击也行）
.\hzj-ai-aftersales\启动网页（推荐用扩展，详见README）.bat
# 然后浏览器打开 http://127.0.0.1:8799/
```

扩展：浏览器 `edge://extensions/` → 开「开发人员模式」→「加载解压缩的扩展」→ 选 `hzj-ai-aftersales\extension` 文件夹。

---

## 四、⚠️ 三条硬规则

### 1. 编辑 `.ps1` 后必须存成「UTF-8 带 BOM」

PowerShell 5.1 读 `.ps1` 时，**没有 BOM 就按系统 ANSI 代码页解析**。
中文会变乱码，进而破坏字符串引号配对，**整个脚本语法错误**：

```
+   Write-Host ("  Windows OCR 鍙敤璇█锛? + ($ocrLangs -join ', '))
Unexpected token 'Windows' in expression or statement.
```

救急命令（跑一遍就好）：

```powershell
$b = New-Object System.Text.UTF8Encoding($true)
Get-ChildItem -Recurse -Filter *.ps1 .\hzj-ai-aftersales | ForEach-Object {
  $t = [System.IO.File]::ReadAllText($_.FullName, (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($_.FullName, $t, $b)
}
```

HTML / CSS / JS / CSV **不需要** BOM（编码由 HTTP 头或 `-Encoding UTF8` 指定）。

### 2. 绝对不要提交密钥

- API Key 用 **Windows DPAPI 加密**存在 `%APPDATA%\hzj-agent\`（或兜底的 `hzj-ai-aftersales\.secrets\`），**不在仓库里**
- 两个位置都已被 `.gitignore` 挡住
- 配置模板是 `hzj-ai-aftersales/config.example.json`；本地实际配置 `config.local.json` **不要提交**
- 提交前如果你不确定，跑一遍：

```powershell
git status --short          # 看有没有意外新增的文件
git ls-files | Select-String 'credential|\.secrets|config\.local'   # 应该为空
```

> 如果你**不小心提交了密钥**：先用 `git reset --soft HEAD~1` 撤销提交，
> 再改密钥（视为已泄露），不要只是删文件后再提交 —— 历史里还在。

### 3. 提交前跑自检，别让主干变红

```powershell
# 后端逻辑
powershell -NoProfile -ExecutionPolicy Bypass -File .\hzj-ai-aftersales\tools\selfcheck.ps1

# 前端/扩展 JS 语法（Node 真解析；Node 装在 C:\Program Files\nodejs\node.exe）
Get-ChildItem -Recurse -Filter *.js .\hzj-ai-aftersales\web, .\hzj-ai-aftersales\extension |
  ForEach-Object { & "C:\Program Files\nodejs\node.exe" --check $_.FullName }

# 双语渲染单元测试
& "C:\Program Files\nodejs\node.exe" .\hzj-ai-aftersales\tools\test-render.js

# 布局实测（无头 Edge，会自己起专用端口）
powershell -NoProfile -ExecutionPolicy Bypass -File .\hzj-ai-aftersales\tools\layout-check.ps1
```

四项全绿再提交。当前状态：**全部通过**。

---

## 五、改哪里的代码

| 想改什么 | 改哪个文件 | 注意 |
|---|---|---|
| 界面布局 / 样式 | `hzj-ai-aftersales/web/index.html`、`style.css` | 改完跑 `layout-check.ps1` |
| 界面渲染逻辑 | `hzj-ai-aftersales/web/app.js` | 改完跑 `test-render.js` |
| 意图识别 / 话术模板 | `hzj-ai-aftersales/engine/pipeline.ps1` | 改完跑 `selfcheck.ps1` |
| 合规规则 | `agent设计/data/compliance_rules.csv` | **改完必须复制到 `hzj-ai-aftersales/data/`**，见下 |
| 上游提示词 | `agent设计/prompts/*.md` | 同上，且模型调用是直接从 md 抽代码块 |
| 各平台 DOM 适配 | `hzj-ai-aftersales/extension/adapters/*.js` | 新增平台 = 加一个文件 + 注册一行 |
| 读取方式 | `hzj-ai-aftersales/engine/reader.ps1`（UIA/剪贴板）、`ocr.ps1`（OCR） | — |

### 数据文件是"两份"的（容易漏）

`agent设计/data/` 是**源头**，`hzj-ai-aftersales/data/` 是演示用的**副本**。改了源头要同步：

```powershell
Copy-Item .\agent设计\data\*.csv .\hzj-ai-aftersales\data\ -Force
```

（之所以不共用，是为了让 `hzj-ai-aftersales/` 能独立拷走运行。）

### 意图标签是"单一真源 + 四处引用"

改 `intent_taxonomy.csv` 的标签时，**四处都要同步**，漏一处会让结构化输出持续报错：

1. `agent设计/data/intent_taxonomy.csv`
2. `agent设计/prompts/02-意图情绪Agent-系统提示词.md` 的标签表
3. `agent设计/schemas/intent_emotion.schema.json` 的 enum
4. `agent设计/schemas/main_output.schema.json` 的 enum

---

## 六、分支与提交

没有强制规范，但建议：

- 主分支 `master` 保持随时可跑（四项自检全绿）
- 新功能开分支：`git checkout -b feat/xxx`，改完提 PR
- 提交信息写**"为什么"**而不只是"改了什么"

例：

```
fix(web): 候选卡片被 flex 压扁导致内容被裁

#candidates 是 column flex 容器，子项默认 flex-shrink:1，
卡片被压缩进容器高度，scrollHeight 恰好等于 clientHeight，
容器以为不用滚，叠加 overflow:hidden 后文字直接被裁。
改为 flex:0 0 auto，让容器真正溢出。
```

---

## 七、常见坑速查

| 现象 | 原因 | 解法 |
|---|---|---|
| 脚本报"Unexpected token"且中文乱码 | `.ps1` 丢了 BOM | 见第四节第 1 条 |
| 端口被占 | 已有实例在跑 | 启动脚本会自动识别或顺延端口，不用手动改 |
| 扩展读不到对话 | 平台 DOM 与推测的选择器不符 | 点侧边栏 ⚙ 用**拾取器**现场教一次 |
| 某列滚不动 | 布局链上缺 `min-height:0`，或 flex 子项被压扁 | 跑 `layout-check.ps1` 看实测数据 |
| 模型没生效 | `provider` 还是 `local`，或没配 Key | 跑 `tools\test-model.ps1 -DryRun` 核对 |
| 改了规则没生效 | 只改了 `agent设计/data/`，没同步到 `hzj-ai-aftersales/data/` | 见第五节 |

---

## 八、不要做的事

- ❌ 提交 `hzj-ai-aftersales/logs/`（运行产物，已忽略）
- ❌ 提交 `config.local.json` / `credential.dat` / `.secrets/`
- ❌ 在代码里硬编码 API Key 或商户真实数据
- ❌ 把 `case_kb` 里未脱敏的真实客户对话提交上来
- ❌ 为了省事把 `compliance_rules.csv` 里的规则删掉——那是法务要确认的资产

---

## 九、法务相关（重要）

`agent设计/data/compliance_rules.csv` 与 `policy_index.csv` 里的法条编号、期限、
运费承担口径，目前**全部是 `seed` 状态，未经法务确认**。

- 这些是**工程种子数据，不是法律意见**
- 上线前必须由法务逐条核实，把 `status` 从 `seed` 改为 `active`
- 改这些文件时，请不要删掉 `verified_by` / `review_cycle_days` 字段
