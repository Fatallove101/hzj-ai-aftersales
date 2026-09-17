# 04 · 千帆 AppBuilder 搭建实施手册

> 目标：把 `01`~`03` 的设计，在百度智能云千帆上真正搭出来，并发布给自建 Web 坐席工作台调用。

---

## ⚠️ 关于本文档准确性的说明（请先读）

百度千帆的文档站是**动态渲染**的，正文内容需要浏览器执行 JS 才能加载，
因此本文档**无法逐字核对官方文档中的节点名称与接口路径**。

本文档的处理方式是诚实的双层命名：

- **概念节点名**（如「大模型节点」「知识库检索节点」）= 本方案自己定义的、稳定的功能名，全文档统一使用；
- **控制台节点名**（标为 `【核对】`）= 需要在控制台里按功能就近匹配，**名称可能随版本变化**。

**已核实可用的官方入口（2026-01 抓取）**：

| 资源 | 链接 | 说明 |
|---|---|---|
| 千帆产品文档总览 | <https://cloud.baidu.com/doc/qianfan/index.html> | 官方文档首页 |
| 应用开发（快速搭建应用） | <https://cloud.baidu.com/doc/qianfan/s/hmh4stph5> | 搭建应用的主文档 |
| 工具及 MCP 广场（组件广场） | <https://cloud.baidu.com/doc/qianfan/s/1mh4stp3t> | 官方插件/工具/MCP |
| 模型服务 | <https://cloud.baidu.com/doc/qianfan/s/1mh4su5jg> | 模型接入与选型 |
| 平台简介 | <https://cloud.baidu.com/doc/qianfan/s/rmh8khvwu> | 平台能力总览 |
| 模型服务计费 | <https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya> | 计费口径 |
| 系统管理 | <https://cloud.baidu.com/doc/qianfan/s/wmh8l6tnf> | 权限、密钥等 |
| Agent 开发控制台 | <https://console.bce.baidu.com/qianfan/> | 控制台入口 |
| 官方应用中心 | <https://console.bce.baidu.com/qianfan/studio/officialAppCenter> | 官方模板，建议从这里起步 |

官方对千帆的定位描述（原文口径）：**"全新的百度千帆以 Agent 为核心，为企业提供模型、Agent 开发及数据智能服务等一站式服务"**，
围绕 **Agent 引擎、工具及 MCP、模型服务、企业级服务** 四大关键要素构建能力底座。

> **搭建前请先做第 3 节的核对清单**，把 `【核对】` 项在控制台确认一遍，再动手。

---

## 1. 应用形态选择

千帆提供多种应用搭建方式，本方案推荐如下组合：

| 本方案的部分 | 推荐形态 | 理由 |
|---|---|---|
| **同步主链路**（翻译→意图→改写→检索→生成→校验→汇总） | **工作流应用** | 流程固定、需要确定性编排与并行检索，工作流最合适 |
| **6 个子 Agent** | 工作流内的**大模型节点**（配结构化输出） | 子 Agent 本质是"固定输入输出的 LLM 调用"，用节点承载最简单、最可观测、成本最低 |
| **数据闭环 Agent** | **独立的工作流应用**（定时触发） | 异步批处理，不应挂在实时链路上 |
| **需要独立调试/复用的子能力** | 可发布为**组件**，再被工作流引用 | 便于单独迭代与多人协作 |

**关于「多智能体模式」的选择建议**：
如果控制台里有多智能体（Multi-Agent）编排形态，可以把 6 个子 Agent 注册为独立 Agent 由主控调度。
**但对本项目不推荐**，原因有三：
1. 链路是**固定顺序**的，不需要模型做"派发给谁"的决策，交给工作流连线更稳、更省 token；
2. 多 Agent 自由编排会引入**不确定性**，而合规模块最需要确定性；
3. 工作流每一步的输入输出可单独调试，排障成本远低于多 Agent 会话。

> 结论：**用工作流把 6 个 Agent 串起来，而不是让模型自己决定调用谁。**
> 只有"检索哪几个知识库"这一类分支交给模型（即查询改写 Agent 的 `kb_route`）。

---

## 2. 搭建总览（6 个步骤）

```
Step 1  准备知识库       5 个 RAG 知识库 + 文档入库 + 元数据配置
Step 2  准备数据库       建 13 张表 + 导入种子数据
Step 3  建 Agent 节点    7 个节点（6 子 Agent + 1 汇总），配好提示词与结构化输出
Step 4  连工作流         按连线图串起来，加并行检索、条件分支、降级分支
Step 5  调试与压测       单节点调 → 全链路调 → 评测集批量跑
Step 6  发布与接入       发布 API → 接自建 Web 坐席工作台
```

---

## 3. 搭建前核对清单（10 项，必须在控制台确认）

请逐项在控制台确认并记录实际名称，填入本表后再动手：

| # | 要确认的事 | 为什么重要 | 确认结果 |
|---|---|---|---|
| 1 | 工作流中**大模型节点**的实际名称与是否支持**结构化输出 / JSON 模式** | 7 个 Agent 全部依赖结构化输出，不支持就要改用「提示词约束 + 代码节点解析」 | |
| 2 | **知识库检索节点**是否支持**元数据过滤**（metadata filter） | 跨境场景靠 `country`/`platform` 硬过滤保证正确性，不支持则必须改用"检索后代码过滤" | |
| 3 | 是否支持**多个检索节点并行执行**（同层级并发） | 决定能否达成 P95 ≤ 6s 的延迟预算 | |
| 4 | **数据库节点**支持的引擎与操作（建表、查询、SQL 自定义程度） | 需要 JOIN 查询订单+物流+客户，只能单表查询则要预建宽表 | |
| 5 | **代码节点**的语言与依赖（是否支持 Python、能否用正则与第三方库） | 合规第一层正则拦截、PII 脱敏、字段补齐都靠它 | |
| 6 | **循环 / 批处理节点**是否可用于"逐条候选话术做合规校验" | 合规校验需要逐条执行 | |
| 7 | **条件分支节点**的能力（多路分支、表达式复杂度） | 降级分支、转人工分支需要 | |
| 8 | **知识库的切片策略**可选粒度（按长度/按分隔符/自定义） | 政策库要求"不跨条款切"，切片粒度不达标会影响正确性 | |
| 9 | **检索策略**是否支持混合检索（向量+关键词）与 rerank | 政策条文含大量专有名词，纯向量召回效果差 | |
| 10 | **发布形态与调用方式**（API 接口名、鉴权方式、QPS 限制） | 关系到自建坐席工作台怎么接 | |

> 如果第 1 项（结构化输出）不支持：在每个大模型节点的提示词末尾强化 JSON 约束，
> 并**在其后加一个代码节点做 JSON 解析与字段校验**，解析失败即触发该节点的降级分支。
> 这会让链路更脆弱，所以第 1 项不支持时应优先考虑换节点类型或反馈给平台。

---

## 4. Step 1 · 建知识库

按 `03-知识库与数据层设计.md` 第 2 节建 5 个知识库。以 `policy_kb` 为例的配置：

| 配置项 | 取值 | 依据 |
|---|---|---|
| 知识库名称 | `policy_kb` | 与 `kb_route` 的 enum 保持一致 |
| 用途描述 | 各国跨境售后政策法规与官方指南 | 帮助平台侧做检索路由 |
| 数据来源 | 上传文档（先传 `data/policy_index.csv` 扩写成的文档） | MVP 阶段先跑通 |
| 切片长度 | 300~500 字 | 保证不跨条款 |
| 分隔符 | 优先按标题层级 / 条款编号切 | 政策文档的天然边界 |
| 向量模型 | 使用平台默认推荐 | 中文政策文本，默认模型通常可用 |
| 检索策略 | 混合检索（向量 + 关键词）+ rerank | 法条含专有名词，纯向量易漏 |
| 召回数量 | 5 | 见 `03` 的第 2.2 节参数表 |
| 分数阈值 | 0.55 | 同上 |

**元数据字段（必须配置，否则无法做硬过滤）**：

```
country        文本    如 DE / ES / FR / US / GB / EU
region         文本    如 EU / GB / NA
policy_name    文本
doc_id         文本    与 policy_index 表对齐，用于时效校验
effective_date 日期    检索时强制 <= today
expiry_date    日期    可为空
source_url     文本
status         文本    active / seed
```

**入库顺序建议**：`policy_kb` → `platform_rule_kb` → `product_kb` → `compliance_kb` → `case_kb`。
先建前两个，链路就能跑出有意义的结果；`case_kb` 放最后（初期数据稀缺，见申报书风险章节）。

> **重要**：`case_kb` 入库前必须完成脱敏，且只入库 `anonymized = true` 的文档。
> 建议先在本地做一遍正则脱敏 + 人工抽查，再上传。

---

## 5. Step 2 · 建数据库

1. 在千帆的数据库能力中创建实例（`【核对】`第 4 项）。
2. 执行 `data/db_schema.sql` 建 13 张表。
3. 导入种子数据：`glossary_zh_en_es_de_fr.csv` → `glossary`，`compliance_rules.csv` → `compliance_rules`，
   `policy_index.csv` → `policy_index`。
4. 业务表（`orders` / `products` / `customers` / `shipments`）接商户真实数据源。

**如果平台的数据库节点只支持单表查询**（不支持 JOIN），需要预建两张宽表：

```sql
-- 宽表1：工作台与话术生成需要的一次性订单上下文
CREATE TABLE v_order_context AS
SELECT o.order_id, o.merchant_id, o.channel, o.country, o.amount, o.currency,
       o.order_status, o.promised_delivery, o.delivered_at,
       s.tracking_no, s.carrier, s.status AS ship_status, s.last_event, s.exception_reason,
       c.lang, c.vip_level, c.order_count, c.history_disputes,
       p.category, p.fabric_composition, p.care_instructions
FROM orders o
LEFT JOIN shipments s ON s.order_id = o.order_id
LEFT JOIN customers c ON c.customer_id = o.customer_id
LEFT JOIN products  p ON p.sku = o.sku;

-- 宽表2：合规校验一次性取回适用规则（避免逐条查询）
CREATE TABLE v_applicable_rules AS
SELECT * FROM compliance_rules
WHERE status IN ('active','seed')
ORDER BY FIELD(severity,'block','revise','warn');
```

---

## 6. Step 3 · 建 Agent 节点（7 个）

每个 Agent 对应一个**大模型节点**。逐个配置如下。

### 6.1 通用配置模板

| 配置项 | 取值 |
|---|---|
| 节点名称 | 建议 `A1_translate` / `A2_intent` / `A3_rewrite` / `A4_generate` / `A5_compliance` / `A0_orchestrate` |
| 系统提示词 | 从 `prompts/` 对应文件复制**代码块内的全部内容** |
| 用户提示词 | 用平台变量语法引用上游变量，见下表 |
| 模型 | 见下表 |
| Temperature | 见下表 |
| 输出格式 | JSON / 结构化输出，Schema 见下表 |
| 异常处理 | 配置为「失败继续 + 走降级分支」（除合规节点） |

### 6.2 节点参数表

| 节点 | 模型 | Temp | 结构化输出 Schema | 输入变量 | 失败策略 |
|---|---|---|---|---|---|
| `A0_orchestrate` | ERNIE 4.5/5.0 | 0.2 | `schemas/main_output.schema.json` | `{{translation_json}}` `{{analysis_json}}` `{{retrieval_json}}` `{{candidates_json}}` `{{compliance_json}}` `{{degraded_nodes}}` | 走规则版排序 |
| `A1_translate` | ERNIE 4.5 | 0.1 | `schemas/translation.schema.json` | `{{raw_text}}` `{{source_lang}}` `{{target_lang}}` `{{direction}}` `{{glossary_json}}` | 透传原文 + `low_confidence` |
| `A2_intent` | ERNIE 4.5 | 0.1 | `schemas/intent_emotion.schema.json` | `{{translated_text}}` `{{context_turns}}` `{{customer_profile_json}}` `{{order_snapshot_json}}` | 默认 other/neutral/high + **强制转人工** |
| `A3_rewrite` | ERNIE 4.5 | 0.2 | `schemas/query_rewrite.schema.json` | `{{translated_text}}` `{{primary_intent}}` `{{customer_profile_json}}` `{{channel}}` | 用原文单条 query |
| `A4_generate` | ERNIE 4.5/5.0 | 0.7 | `schemas/candidates.schema.json` | `{{evidence_json}}` `{{analysis_json}}` `{{filters_json}}` `{{coverage}}` | 返回兜底模板 |
| `A5_compliance` | ERNIE 4.5 | 0.1 | `schemas/compliance.schema.json` | `{{candidate_json}}` `{{filters_json}}` `{{rules_json}}` `{{passed_by_regex}}` | **全部 reject + 转人工（不放行）** |

> **结构化输出的 Schema 怎么填**：把 `schemas/` 里对应的 JSON 内容直接粘贴到平台的结构化输出配置中。
> 若平台只接受简化 Schema（例如只支持 `type` / `properties` / `required` / `items` / `enum`），
> 本方案的所有 Schema 都已按此约束编写，可直接使用；`$schema` 与 `description` 字段可保留，通常会被忽略。

### 6.3 提示词变量的写法

不同平台变量语法不同（可能是 `{{var}}`、`{var}` 或图形化选择）。**搭建时以控制台的变量选择器为准**，
本文档统一用 `{{var}}` 表示"此处插入上游变量"。

**易错点**：`{{..._json}}` 这类变量传入的是**对象或数组**。
如果平台的提示词变量只接受字符串，需要先经过一个代码节点把对象 `json.dumps()` 成字符串，
否则模型会收到 `[object Object]` 之类的空值。

---

## 7. Step 4 · 连工作流

### 7.1 连线图（概念节点）

```
[开始]
   │
[D1 前置处理 · 代码节点]
   │  语言检测 / PII 脱敏 / 取会话上下文 / 生成 trace_id
   ├──────────────────────────────┐
   │                              │
[A1 翻译]                    [数据库: 客户与订单上下文]
   │                              │
[A2 意图情绪] ◄───────────────────┘
   │
[A3 查询改写]
   │
[条件分支: kb_route]
   ├─► [KB检索: policy_kb]        ┐
   ├─► [KB检索: platform_rule_kb] ├─ 并行
   ├─► [KB检索: product_kb]       │
   ├─► [KB检索: case_kb]          │
   └─► [KB检索: compliance_kb]    ┘
                    │
        [变量聚合: 合并 evidence]
                    │
        [D2 覆盖度判定 · 代码节点] ──► coverage
                    │
              [A4 话术生成]
                    │
        [数据库: 取适用 compliance_rules] ──► rules_json
                    │
        [D3 正则硬拦截 · 代码节点] ──► passed_by_regex
                    │
        [批处理/循环: 逐条候选] ──► [A5 合规校验]
                    │
        [D4 汇总前处理 · 代码节点]
        │   淘汰 reject / 用 revised_text 替换 / 判 coverage 与 risk
        │
        [A0 主控汇总]
        │
        [D5 输出组装 · 代码节点] ──► main_output_json
        │
      [结束]
```

### 7.2 需要额外加的三个确定性节点（不依赖模型）

| 节点 | 职责 | 为什么不能用模型 |
|---|---|---|
| **D1 前置处理** | 语言检测、PII 脱敏、trace_id、上下文截断 | 安全相关，必须确定性 |
| **D2 覆盖度判定** | 按 `03` 的 2.3 节规则算 `coverage` | 主控的转人工决策依赖它，不能靠模型主观判断 |
| **D3 正则硬拦截** | 用 `compliance_rules.pattern` 跑正则，**只跑 `match_mode = 'violation'` 的规则** | 违规判定必须 100% 可复现；`obligation` 类规则（正向义务）不可用正则，见 `03` 第 4.2 节 |
| **D4 汇总前处理** | 淘汰 reject、替换 revised_text、算排序分 | 属于"确定性的数据清洗"，模型做容易出错 |

> **设计原则**：凡是能用代码写清楚的，不要交给模型。
> 模型只负责三件事：**理解语言**（翻译）、**判断语义**（意图/合规）、**生成文本**（话术）。

### 7.3 降级分支的接线方式

每个 Agent 节点都要接一条失败分支，连到一个代码节点写降级默认值，
并把节点名追加到 `degraded_nodes` 数组。具体降级值见 `01-总体架构与编排设计.md` 第 7 节。

**合规校验节点是唯一例外**：它的失败分支直接连到「全部 reject + 转人工」，**没有降级放行**。

---

## 8. Step 5 · 调试与压测

### 8.1 三阶段调试

| 阶段 | 做法 | 通过标准 |
|---|---|---|
| **单节点调** | 每个 Agent 用 3~5 条构造输入单独跑 | 输出能通过对应 JSON Schema 校验 |
| **全链路调** | 用完整入参跑通一次，逐节点看变量 | 最终 JSON 结构完整，无 null 数组元素 |
| **评测集批量** | 用 `05-评测与迭代运营方案.md` 的评测集跑批 | 达到各 Agent 的验收标准 |

### 8.2 必测的 8 个边界用例

| # | 用例 | 期望行为 |
|---|---|---|
| 1 | 客户本来就发中文 | 翻译 `skipped = true`，链路正常 |
| 2 | 客户国家未知 | `coverage = insufficient`，`need_human = true`，无政策承诺 |
| 3 | 客户消息含"加微信私下转账" | 合规 `reject`，不进最终输出 |
| 4 | 客户威胁"要找律师起诉" | `urgency = critical`，`risk_flags` 含 `legal_risk`，转人工 |
| 5 | 知识库全部零结果 | 走兜底话术 + 转人工，兜底话术不含政策期限 |
| 6 | 合规节点超时/异常 | 全部 `reject` + 转人工（**绝不放行**） |
| 7 | 儿童服装安全问题 | `minor_involved` + `legal_risk` + `critical` |
| 8 | 同一会话连续 3 次忽略推荐 | `low_acceptance` 触发转人工 |

### 8.3 压测要点

- 目标：P95 ≤ 6s，P99 ≤ 10s。
- 关注**并行检索**是否真的并行（串行会直接吃掉延迟预算）。
- 记录每个节点的耗时，写进 `meta.latency_ms` 的分项统计（建议扩展 `meta` 加 `node_timings`）。
- 若超标，按 `01` 第 4 节的优化顺序处理，不要先降模型档次（会伤生成质量）。

---

## 9. Step 6 · 发布与接入自建工作台

### 9.1 发布

在工作流应用页面发布应用。发布形态通常包括网页分享链接、API 调用、以及若干渠道接入
（`【核对】`第 10 项，以控制台实际提供的选项为准）。

**推荐**：发布为 **API**，由自建 Web 坐席工作台调用。
理由：工作台需要展示候选话术卡片、来源引用、合规标注、转人工交接包等自定义 UI，
平台的通用对话页无法满足。

### 9.2 工作台调用示意

```
POST  {千帆应用调用地址}                 # 接口路径与鉴权方式以控制台/官方文档为准
Headers:
  Authorization: Bearer {access_token}   # 鉴权方式以官方文档为准
  Content-Type: application/json

Body:
{
  "session_id": "sess_8891",
  "merchant_id": "hz_1024",
  "order_id": "TS-8830012",
  "channel": "tiktok_shop",
  "raw_text": "El vestido llegó con manchas y quiero mi dinero",
  "source_lang": "es",
  "context_turns": 4
}

Response:  即 schemas/main_output.schema.json 的结构
```

> 千帆的对话类 API 参数与返回结构可能包含 `conversation_id`、`query`、`response` 等字段，
> **具体的接口名、字段名与鉴权流程请以控制台「应用发布」页给出的示例代码为准**，
> 平台通常会直接提供 curl / Python 示例，照抄即可，不要照搬本文档的示意结构。

### 9.3 工作台必须实现的 6 个交互

| # | 交互 | 依赖字段 |
|---|---|---|
| 1 | 展示 ≤3 条候选话术卡片（带风格标签） | `candidates[]` |
| 2 | 每条卡片展示**来源引用**（可点开看政策原文） | `candidates[].cited_evidence` + `retrieval.evidence[]` |
| 3 | 展示风险提示（修订过的话术、`unsupported` 话术） | `compliance[].decision` / `risk_notes` / `unsupported` |
| 4 | 一键复制 + 微调编辑框 | `final.reply_text_target` |
| 5 | 转人工按钮 + 交接包弹窗 | `escalation.need_human` / `handoff_packet` |
| 6 | 采纳 / 修改 / 忽略 三态记录 + 满意度回填 | 写回 `qa_logs` / `feedback` |

**第 6 项是数据闭环的入口**，必须做，否则数据闭环 Agent 没有输入，整个优化闭环会断掉。

---

## 10. 成本控制要点

| 措施 | 说明 | 预计影响 |
|---|---|---|
| 中文消息跳过翻译 | `skipped = true` 时不调用模型 | 减少约 20% 翻译调用 |
| 候选话术先只回译推荐候选 | 其余候选等客服选定后再回译 | 减少约 40% 生成 token |
| 合规规则前置正则拦截 | 命中硬规则不送模型 | 减少约 15%~25% 合规调用 |
| 多路检索按 `kb_route` 路由 | 不检索用不到的知识库 | 减少约 30% 检索量 |
| 会话级结果缓存 | 30s 内相同 `session_id` + `raw_text` 返回缓存 | 防重复扣费 |
| 子 Agent 用合适档位的模型 | 翻译/意图/改写用中档，仅话术生成用最强模型 | 显著降本 |

**新用户福利**：官方页面提到新用户注册并实名认证可获代金券（当前口径为 20 元，具体以控制台活动页为准），
开发调试期可覆盖大部分验证成本。

---

## 11. 常见坑（按踩坑概率排序）

| # | 坑 | 现象 | 规避方式 |
|---|---|---|---|
| 1 | 用多智能体自由编排 | 模型自己决定调用顺序，偶发跳过合规校验 | **用工作流固定连线**，合规校验不能被跳过 |
| 2 | 检索不带 `country` 过滤 | 德国客户拿到美国政策，看起来专业但完全错误 | `filters.country` 必须硬过滤；UNKNOWN 直接判 insufficient |
| 3 | 政策不做时效过滤 | 引用已废止条款 | 强制 `effective_date <= today`，在 `policy_index` 表二次校验 |
| 4 | 结构化输出没有兜底解析 | 模型偶尔输出多一句解释，整个节点失败 | 后置代码节点做容错解析（提取首个 `{` 到末个 `}`），失败再走降级 |
| 5 | 把 `{{..._json}}` 当字符串用 | 模型收到空值，输出莫名其妙 | 先 `json.dumps` 再注入，或使用平台的变量选择器 |
| 6 | 合规校验失败时"降级放行" | 未校验话术发给客户 | **合规失败一律 reject**，宁可不给 |
| 7 | 案例库未脱敏 | 客户隐私泄露，属重大事故 | 入库前强制脱敏 + `anonymized` 标记 + 人工抽查 |
| 8 | 意图标签 enum 三处不一致 | 节点持续报错并降级 | 改标签时同步改 `intent_taxonomy.csv` + 2 个 Schema + 2 个提示词 |
| 9 | 串行检索 | P95 飙到 10s+ | 检索必须并行 |
| 10 | 兜底话术成了主路径 | 兜底使用率 > 10%，说明知识库或检索有问题 | 把兜底使用率作为监控指标，超阈值触发 P0 排查 |

---

## 12. 搭建完成后自检清单

- [ ] 5 个知识库建成，元数据字段齐全，`policy_kb` 已配 `effective_date` 硬过滤
- [ ] 13 张表建成，种子数据导入成功，`policy_index` 与 `policy_kb` 的 `doc_id` 对齐
- [ ] 7 个 Agent 节点提示词已粘贴，结构化输出 Schema 已配置
- [ ] 每个节点都接了降级分支，合规节点接的是"全部 reject"
- [ ] 检索并行执行已验证确实是并发
- [ ] 8 个边界用例全部通过
- [ ] P95 ≤ 6s
- [ ] 最终 JSON 100% 通过 `schemas/main_output.schema.json` 校验
- [ ] `reject` 话术零泄漏（抽样 200 条验证）
- [ ] `qa_logs` 中无明文 PII
- [ ] 工作台 6 个交互全部实现
- [ ] 数据闭环 Agent 独立工作流已配置定时触发
