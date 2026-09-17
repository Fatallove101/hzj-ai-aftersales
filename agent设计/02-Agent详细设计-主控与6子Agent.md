# 02 · Agent 详细设计（主控 + 6 子 Agent）

> 本文是**开发规格书**：每个 Agent 的定位、触发、输入输出、模型与参数、千帆落地形态、失败降级、验收标准。
> 可直接粘贴的系统提示词在 `prompts/`，字段级 JSON Schema 在 `schemas/`。

---

## 通用约定

- **内部工作语言**：中文。多语言只在入口（翻译）和出口（回译）处理。
- **结构化输出**：除话术文本外，所有 Agent 输出必须是严格 JSON，字段名与 `schemas/` 一致，禁止夹带解释性文字。
- **温度建议**：判断类（意图、合规、改写）`temperature = 0.1~0.3`；生成类（话术）`temperature = 0.7`。
- **禁止行为**：任何 Agent 都不得自行承诺赔偿金额、时效、平台判罚结果。

---

## A0 · 主控 Agent（Orchestrator）

| 项 | 内容 |
|---|---|
| **一句话定位** | 全链路的总调度与最终出口，负责串流程、汇总结果、决定是否转人工，产出最终 JSON |
| **触发** | 客服工作台发起 / 消息网关 webhook |
| **输入** | `session_id`, `merchant_id`, `order_id`, `channel`, `raw_text`, `source_lang`, `context_turns` |
| **输出** | `schemas/main_output.schema.json`（最终 JSON） |
| **关键输出字段** | `final.recommended_candidate_id`, `final.reply_text_target`, `escalation.need_human`, `meta` |
| **模型** | 文心 ERNIE 4.5 / 5.0（汇总与排序），配合代码节点做确定性淘汰 |
| **Temperature** | 0.2 |
| **千帆承载** | 工作流主干；用一个「大模型节点」做排序理由与 `ranking_basis`，用「代码节点」做 reject 淘汰与推荐位选择 |
| **提示词** | `prompts/00-主控Agent-系统提示词.md` |

**职责拆解**

1. **编排**：按固定顺序调用子 Agent；并行发起多路检索。
2. **汇总**：合并各子 Agent 输出，构造完整 JSON；任何缺失字段填降级默认值并在 `meta.degraded_nodes` 记录。
3. **淘汰与排序**：
   - `decision == "reject"` 的候选**直接删除**；
   - `decision == "revise"` 的候选使用 `revised_text` 替换原文，保留修订痕迹；
   - 排序权重：`intent_fit 0.35 + emotion_fit 0.25 + evidence_strength 0.25 + compliance_score 0.15`。
4. **转人工判定**：按 `01-总体架构与编排设计.md` 第 8 节规则表执行，输出 `handoff_packet`。
5. **兜底**：`coverage == "insufficient"` 时禁止输出任何政策承诺型表述，只输出通用安抚 + 转人工。

**失败降级**：主控本身不调用模型也可运行（纯代码节点版）；模型节点失败时用规则版排序并在 `meta.degraded_nodes` 加 `orchestrator_llm`。

**验收标准**
- `reject` 话术零泄漏：抽样 200 条，最终 JSON 中不存在被 reject 的文本（必须 100%）。
- `need_human` 判定与人工标注一致率 ≥ 90%。
- 输出 100% 通过 `schemas/main_output.schema.json` 校验。

---

## A1 · 翻译 Agent

| 项 | 内容 |
|---|---|
| **一句话定位** | 中/英/西/德/法互译，服装术语适配，为内部链路提供中文工作文本，为客户提供目标语回复 |
| **触发** | 主链路第 2 步；出口回译时再次调用（`direction=zh2target`） |
| **输入** | `raw_text`, `source_lang`, `target_lang`, `direction`, 术语库命中候选 |
| **输出** | `schemas/translation.schema.json`：`translated_text`, `glossary_hits`, `quality_flag`, `skipped` |
| **关键输出字段** | `translated_text` |
| **模型** | 文心 ERNIE 4.5（原生多语言）；术语一致性要求高时可用 few-shot 注入术语表 |
| **Temperature** | 0.1 |
| **千帆承载** | 大模型节点（结构化输出）；术语库可作为知识库检索节点前置注入，或直接用数据库节点拉取命中的术语行 |
| **提示词** | `prompts/01-翻译Agent-系统提示词.md` |

**设计要点**

1. **双向能力**：`direction = target2zh`（客户→内部，用于理解）与 `zh2target`（内部→客户，用于回译）共用同一 Agent，提示词分模式。
2. **术语优先**：先按 `data/glossary_zh_en_es_de_fr.csv` 做确定性替换（代码节点），再做整句润色。避免模型自由发挥术语。
3. **保留原文情感强度**：西语/德语客户情绪表达更强，翻译不得弱化或强化（严禁把 "¡Es una estafa!" 淡化成"有点不满意"）。
4. **不译内容**：订单号、SKU、金额、尺码数字、URL —— 原样保留并加占位符保护。
5. **质量标记**：以下情况置 `quality_flag = "low_confidence"`：小语种（非 en/es/de/fr）、俚语/混合语言、原文有大量拼写错误、术语库无命中且含专业词。
6. **已是中文时**：`skipped = true`，直接透传，不消耗模型调用。

**失败降级**：超时则透传原文，`quality_flag = "low_confidence"`，下游意图识别改用原文。

**验收标准**
- 术语命中准确率 ≥ 95%（人工抽检 100 句）。
- 关键信息（金额/尺码/订单号）保留率 100%。
- 回译后客户可读性人工评分 ≥ 4/5。

---

## A2 · 意图情绪 Agent

| 项 | 内容 |
|---|---|
| **一句话定位** | 识别退款、换货、物流、质量、差评、复购等意图，判断情绪与紧急度 |
| **触发** | 主链路第 3 步 |
| **输入** | `translated_text`, 最近 2 轮上下文, `customer_profile`, `order_snapshot` |
| **输出** | `schemas/intent_emotion.schema.json`：`intents[]`, `primary_intent`, `emotion`, `urgency`, `risk_flags` |
| **关键输出字段** | `intent`（多标签）, `emotion`, `urgency` |
| **模型** | ERNIE 4.5 + 结构化输出；对成本敏感可用更小模型（该任务 token 少、难度中） |
| **Temperature** | 0.1 |
| **千帆承载** | 大模型节点（结构化输出）。若追求更稳，可先接「意图识别」类节点做粗分类，再由大模型节点细分 |
| **提示词** | `prompts/02-意图情绪Agent-系统提示词.md` |

**标签体系**（完整定义见 `data/intent_taxonomy.csv`）

| 维度 | 取值 |
|---|---|
| **intent（可多标签）** | `refund` 退款、`exchange` 换货、`logistics` 物流催件/丢件、`quality_defect` 质量投诉、`color_diff` 色差、`sizing` 尺码问题、`negative_review` 差评维权、`repurchase` 复购咨询、`product_info` 产品咨询、`payment` 支付问题、`customs` 关税清关、`invoice` 发票、`complaint_service` 服务态度投诉、`other` |
| **emotion.polarity** | `negative` / `neutral` / `positive` |
| **emotion.intensity** | 1（平静）~ 5（极端，含威胁/辱骂/曝光威胁） |
| **urgency** | `low` / `medium` / `high` / `critical` |
| **risk_flags** | `chargeback_risk` 拒付风险、`platform_intervention_risk` 平台介入、`legal_risk` 法律风险、`public_opinion_risk` 舆情风险、`repeat_complaint` 重复投诉、`minor_involved` 涉未成年人 |

**判定规则（写进提示词）**

- 出现"曝光/投诉到平台/找律师/报警/差评/差评截图"等 → `intensity ≥ 4`，并加 `public_opinion_risk` 或 `legal_risk`。
- 提到 `chargeback` / `disputa` / `reclamación` / `A-to-z` / `claim` → `risk_flags += chargeback_risk`。
- 时间敏感词（"已经等了10天""再不处理就…"）→ `urgency ≥ high`。
- 涉及婴儿/儿童服装安全（绳带、阻燃、小部件脱落）→ `risk_flags += legal_risk`，`urgency = critical`。
- 客户仅礼貌询问（"请问什么时候发货"）→ `emotion = neutral`, `urgency = medium`。

**失败降级**：默认 `primary_intent="other"`, `emotion=neutral/intensity=3`, `urgency="high"`，并**强制转人工**。

**验收标准**
- `primary_intent` 准确率 ≥ 90%（分层抽样 300 条，覆盖全部标签）。
- `urgency` 分级准确率 ≥ 85%；`critical` 召回率 ≥ 95%（漏判代价高，宁多勿少）。
- 情绪强度与人工标注的 ±1 内一致率 ≥ 85%。

---

## A3 · 查询改写 Agent

| 项 | 内容 |
|---|---|
| **一句话定位** | 把客户口语化问题改写成千帆知识库能命中的检索 query，并产出元数据过滤条件 |
| **触发** | 主链路第 4 步 |
| **输入** | `translated_text`, `intents[]`, `customer_profile.country`, `channel`, 商品品类 |
| **输出** | `schemas/query_rewrite.schema.json`：`queries[]`, `filters`, `kb_route[]`, `rewrite_rationale` |
| **关键输出字段** | `queries`, `filters` |
| **模型** | ERNIE 4.5，结构化输出；`temperature = 0.2` |
| **千帆承载** | 大模型节点（结构化输出）→ 输出直接绑定到多个知识库检索节点的 `query` 与 `metadata_filter` 参数 |
| **提示词** | `prompts/03-查询改写Agent-系统提示词.md` |

**设计要点**

1. **多路召回**：输出 2~4 条 query，覆盖不同侧面（政策面、产品面、案例面），避免单 query 漏检。
   - 示例（订单污渍投诉，西班牙）：
     - `西班牙 服装 到货污渍 质量问题 退货 运费谁承担`
     - `TikTok Shop 西班牙站 商品瑕疵 退款政策`
     - `连衣裙 污渍 质量投诉 处理话术 案例`
2. **口语 → 书面政策语**：把"衣服破了"改写成"服装 破损 质量问题 退换货 政策"。**不要把客户情绪词带进 query**（"骗子""垃圾"会污染检索）。
3. **元数据过滤**：`filters` 必须填 `country` / `platform` / `category` / `policy_version`。**这是跨境场景的正确性关键** —— 同一个退款问题，德国和美国的答案不同。
4. **时效过滤**：`policy_version` 默认 `latest`，并强制 `effective_date <= today`，避免检索到已废止政策。
5. **知识库路由**：`kb_route` 决定检索哪几个库，减少无效检索、降低成本。
   - 涉及政策/合规 → `policy_kb` + `platform_rule_kb`
   - 涉及产品/尺码/面料 → `product_kb`
   - 需要处理经验 → `case_kb`
   - 翻译术语 → 不走 RAG，走 `glossary` 结构化表
6. **零结果回退**：若初检零结果，自动放宽（去掉 `category`，再放宽 `country`），并记录 `relaxed: true`。

**失败降级**：直接用 `translated_text` 原文作为单条 query 检索。

**验收标准**
- 检索召回率（Recall@5）≥ 85%（用 `05-评测与迭代运营方案.md` 的评测集）。
- `filters` 的 `country` / `platform` 填充率 ≥ 95%。
- 无效 query（零结果）比例 ≤ 10%。

---

## A4 · 话术生成 Agent

| 项 | 内容 |
|---|---|
| **一句话定位** | 结合意图、情绪、证据与场景，生成 ≤3 条差异化候选话术，覆盖五种风格 |
| **触发** | 主链路第 6 步（检索完成之后） |
| **输入** | `evidence[]`, `primary_intent`, `emotion`, `urgency`, `filters`, `customer_profile`, `case_style_hint` |
| **输出** | `schemas/candidates.schema.json`：`candidates[]`（≤3） |
| **关键输出字段** | `candidates[].style`, `text_zh`, `text_target`, `cited_evidence` |
| **模型** | ERNIE 4.5 / 5.0（生成质量最关键的一环，建议用最强模型）；`temperature = 0.7` |
| **千帆承载** | 大模型节点（生成 + 结构化输出），前置知识库检索结果作为上下文注入 |
| **提示词** | `prompts/04-话术生成Agent-系统提示词.md` |

**五种话术风格**（来自申报书 3.1）

| 风格 | 适用场景 | 语气要点 |
|---|---|---|
| **安抚致歉** | 质量投诉、到货破损、色差、物流延误 | 先承认问题与致歉，不辩解、不追问细节 |
| **专业答疑** | 尺码、面料、保养、使用说明 | 给参数、给标准、给依据，不下主观结论 |
| **营销促单** | 复购咨询、犹豫客户、换货时可加购 | 给优惠、给搭配建议，**不得虚假承诺与绝对化用语** |
| **纠纷调解** | 索赔、平台介入、拒付、升级投诉 | 讲规则、给选项、留证据，**不下责任结论** |
| **合规告知** | 政策说明、退货期、关税、隐私 | 明确政策依据与生效日期，引用原文口径 |

**生成约束（硬规则）**

1. 候选数量 ≤ 3；**必须风格互异**，不得 3 条同风格。
2. 首推风格由意图决定：`quality_defect`/`color_diff` → 安抚致歉；`sizing`/`product_info` → 专业答疑；`repurchase` → 营销促单；`refund`/`negative_review` → 纠纷调解；`customs` → 合规告知。
3. **每条话术必须带 `cited_evidence`**（引用 `evidence[].doc_id`）。无可用证据时，输出通用安抚话术并置 `unsupported = true`。
4. **禁止项**（与合规规则库 R001–R020 对齐）：不承诺具体赔偿金额/时间、不索要隐私、不引导站外交易、不诱导好评、不虚构物流信息、不用绝对化用语、不做歧视性表述、不替平台下判罚结论。
5. **长度**：客户可读话术 ≤ 120 词（目标语）/ ≤ 200 字（中文），超长客户不看。
6. **目标语输出**：`text_target` 必须用术语库回译，并与 `filters.country` 的语言一致。
7. **情绪适配**：`intensity ≥ 4` 时，候选**不得**包含任何营销/促单内容。

**失败降级**：按 `primary_intent` 返回固定安抚模板（`data/fallback_templates.md`），标记 `fallback = true`。

**验收标准**
- 候选话术意图匹配率 ≥ 85%（人工评分 ≥ 4/5）。
- `cited_evidence` 非空率 ≥ 90%。
- 风格多样性：三选一时风格互异率 100%。
- 首次经合规校验即 `pass` 的比例 ≥ 70%（衡量生成质量，越低说明提示词需优化）。

---

## A5 · 合规校验 Agent

| 项 | 内容 |
|---|---|
| **一句话定位** | 检查承诺、隐私、平台规则、广告、歧视五类风险，输出 pass / revise / reject |
| **触发** | 主链路第 7 步，逐条候选话术执行 |
| **输入** | `candidate.text_zh`, `candidate.text_target`, `filters.country`, `filters.platform` |
| **输出** | `schemas/compliance.schema.json`：`decision`, `violations[]`, `revised_text` |
| **关键输出字段** | `decision`（`pass` / `revise` / `reject`） |
| **模型** | ERNIE 4.5 + 结构化输出；**规则前置**：正则/关键词硬命中直接判定，不送模型 |
| **Temperature** | 0.1 |
| **千帆承载** | ① 代码节点（正则硬命中，见 `data/compliance_rules.csv` 的 `pattern` 列）→ ② 数据库节点（拉取适用国家/平台的规则行）→ ③ 大模型节点（语义级判定，兜住规则漏网） |
| **提示词** | `prompts/05-合规校验Agent-系统提示词.md` |

**五类校验维度**（对应需求图）

| 类别 | 检查内容 | 典型违规 |
|---|---|---|
| `promise` **承诺** | 赔偿金额、退款时效、到货时间、责任归属 | "保证 3 天内全额退款"、"一定是我们的问题" |
| `privacy` **隐私** | 索要/泄露个人信息、公开他人信息 | 索要银行卡/CVV/验证码、在会话中复述客户地址 |
| `platform_rule` **平台规则** | 站外引流、诱导好评、虚假物流、替平台下结论 | "加我微信私下交易"、"帮我们改成五星" |
| `advertising` **广告** | 绝对化用语、无依据功效宣称 | "全网最好"、"100% 不掉色"、"抗菌防癌" |
| `discrimination` **歧视** | 国别、宗教、性别、体型、年龄歧视 | "你们那个国家的人都这样"、体型嘲讽 |

**判定口径**

- `reject`：命中 `severity = block` 的规则（隐私泄露、歧视、站外引流、诱导好评、虚假承诺时效/金额）。
- `revise`：命中 `severity = revise`，可改写规避（归因结论、绝对化用语、未加政策依据的表述）。
- `pass`：无命中，且所有政策类表述都有 `effective_date` 有效的证据支撑。
- **不确定即 `revise`**：边界模糊时不得 `pass`。宁可让客服多看一眼。

**跨境特有加分项（正向校验）**
- 欧盟/英国订单：话术须体现 14 天无理由退货权（指令 2011/83/EU 及各国转化法），未体现记 `warn`。
- 德国订单：须提示 Widerrufsrecht（撤回权）。
- 不得要求客户承担依法应由商家承担的质量问题退货运费。

> ⚠️ `data/compliance_rules.csv` 与 `data/policy_index.csv` 中的法条与期限为**种子数据**，上线前必须由法务逐条核实并签署确认，见 `03-知识库与数据层设计.md` 第 6 节。

**失败降级**：**不放行**。全部候选 `decision = "reject"` 并 `need_human = true`。

**验收标准**
- 违规召回率 ≥ 95%（在 200 条人工构造的违规样本上）。
- 误杀率（把合规话术判 reject）≤ 5%。
- `revise` 后的文本再次校验必须 `pass`（修订有效性）。
- 所有 `reject` 样本可归因到具体 `rule_id`。

---

## A6 · 数据闭环 Agent（异步）

| 项 | 内容 |
|---|---|
| **一句话定位** | 记录采纳/修改/忽略/满意度，反推知识库缺口，产出优化建议 |
| **触发** | 异步：① 实时事件（每次客服操作）② 定时批处理（T+1，建议 02:00） |
| **输入** | `qa_logs`（采纳/修改/忽略）、`feedback`（满意度/追评）、`after_sales_cases`（工单结果）、`retrieval` 日志 |
| **输出** | `schemas/feedback.schema.json`：`optimization_suggestions[]`, `knowledge_gaps[]`, `metrics` |
| **关键输出字段** | 优化建议（需求图中的要求） |
| **模型** | ERNIE 4.5（聚类结果归因、建议撰写）；聚类本身用规则/向量相似度做 |
| **Temperature** | 0.3 |
| **千帆承载** | **独立工作流**（不与主链路同一应用），用定时触发 + 数据库节点读日志 + 大模型节点归因 |
| **提示词** | `prompts/06-数据闭环Agent-系统提示词.md` |

**产出物**

1. **知识库缺口报告**
   - 检索零结果的 query 聚类（Top 20）→ 应当新增哪些知识条目
   - `coverage == "insufficient"` 的样本 → 哪个知识库覆盖不足
   - 客户反复追问 2 次以上的问题 → 现有话术未解决问题
   - 命中但 `score < 0.6` 的条目 → 该文档需要重写或重新切片
2. **话术质量报告**
   - 采纳率 / 修改率 / 忽略率（按意图 × 风格 × 国别 × 平台拆解）
   - 修改前后 diff 的高频模式 → 提示词与模板改进方向
   - 满意度与采纳率的相关性
3. **合规反馈**
   - 被 reject 的高频模式 → 补充到 `compliance_rules.csv` 的 `pattern` 列（让规则前置更有效）
   - `revise` 高频改写点 → 反向优化话术生成提示词
4. **运营建议**
   - 术语库待新增/修正条目
   - 过时政策条目（`effective_date` 超过复核周期）→ 触发法务复核

**验收标准**
- 每周产出可执行建议 ≥ 5 条，且每条带样本证据（`trace_id` 列表）。
- 建议采纳后，下一周期的采纳率或零结果率有可测改善。
- 数据不可反查到具体客户身份（聚合输出，符合隐私要求）。

---

## 附：Agent 之间的依赖关系图

```
A1 翻译 ──► A2 意图情绪 ──► A3 查询改写 ──► [检索] ──► A4 话术生成 ──► A5 合规校验
                  │                                                  │
                  └──────────► A0 主控（汇总/排序/转人工）◄───────────┘
                                        │
                                        ├──► 客服工作台
                                        └──► A6 数据闭环（异步）
```

**关键依赖说明**
- A4 必须等检索完成（不能凭空白生成政策类话术）。
- A5 必须在 A4 之后、A0 汇总之前（合规闸门不能被绕过）。
- A2 的 `urgency` / `risk_flags` 直接喂给 A0 做转人工判定，A4 做风格选择。
- A3 的 `filters.country` 同时决定 A4 的目标语言与 A5 的适用规则集。
