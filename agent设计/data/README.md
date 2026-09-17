# data/ · 种子数据说明

这个目录是**可直接导入的种子数据**，用来在千帆里先跑通链路，之后再替换成真实业务数据。

## 文件清单

| 文件 | 内容 | 目标去向 | 记录数 |
|---|---|---|---|
| `glossary_zh_en_es_de_fr.csv` | 服装跨境术语库（中英西德法） | 结构化数据库 `glossary` 表 | 46 |
| `compliance_rules.csv` | 合规规则库（含正则 pattern 与 match_mode） | 结构化数据库 `compliance_rules` 表 + 代码节点硬拦截 | 25 |
| `policy_index.csv` | 各国政策索引（含生效日期） | RAG `policy_kb` 文档来源 + `policy_index` 表 | 18 |
| `intent_taxonomy.csv` | 意图标签体系 | 提示词与 JSON Schema enum 的**唯一真源** | 14 |
| `db_schema.sql` | 结构化数据库建表 DDL | 千帆数据库节点建表 | 13 张表 |
| `compliance_unit_test.csv` | 合规规则回归单元测试集 | 改规则后必跑，验证正则层判定与误杀率 | 24 |
| `eval_set_template.csv` | 端到端评测集模板（含对抗样本） | L2 链路评测，按模板扩充到 150~300 条 | 26 |
| `fallback_templates.md` | 降级兜底话术模板（五语言） | 话术生成 Agent 的降级输出 | — |

## 已验证的回归结果

`compliance_unit_test.csv` 已针对 `compliance_rules.csv` 跑过回归，结果：

```
规则总数 25：violation 23 / obligation 2
正则层一致 23 / 需模型层判定 1 / 真实不一致 0 / 共 24
误杀检查（4 条合规正向样本）：正则命中 [] —— 零误杀
```

**改动规则后必须重跑这个回归**。命令逻辑（PowerShell 示意）：

```powershell
$rules = Import-Csv data\compliance_rules.csv -Encoding UTF8 |
         Where-Object { $_.match_mode -eq 'violation' }
$tests = Import-Csv data\compliance_unit_test.csv -Encoding UTF8
# 对每条测试样本跑 $rules.pattern，block 命中→reject，revise 命中→revise，否则 pass
# 与 expected_decision 比对
```

> 这个回归在开发过程中**真实抓到了一个缺陷**：
> R018/R019（欧盟 14 天告知义务、德国撤回权）最初被写成 violation 型规则，
> 导致任何提到"退货/退款"的**合规话术**都被判 revise（误杀率 100%）。
> 修法是引入 `match_mode = obligation`，让正向义务类规则只由模型判定。
> 详见 `03-知识库与数据层设计.md` 第 4.2 节。

## 导入顺序（有依赖关系）

```
1. db_schema.sql          建表
2. glossary_*.csv         → glossary             （无依赖）
3. intent_taxonomy.csv    → 不导入库，直接用于配置 Schema 与提示词
4. compliance_rules.csv   → compliance_rules     （无依赖）
5. policy_index.csv       → policy_index 表
                          → 同时作为 policy_kb 知识库的文档来源（每行扩写成一篇文档）
6. fallback_templates.md  → 存为工作流的静态模板变量
```

## ⚠️ 两处必须由法务确认的数据

**`compliance_rules.csv`** 与 **`policy_index.csv`** 中的法条编号、期限天数、运费承担方口径，
是依据公开信息整理的**种子数据**，`status` 列统一标记为 `seed`、`verified_by` 为 `待法务确认`。

**上线前必须完成**：
1. 由跨境业务顾问 + 法务逐条核实 `policy_index.csv` 的 `key_rule`、`return_window_days`、
   `return_shipping_payer`、`effective_date` 与 `source_url`。
2. 核实后在 `verified_by` / `verified_date` 填写确认人与日期，`status` 改为 `active`。
3. 未完成确认的条目**不得**作为对外话术的依据 —— 建议在检索节点加过滤：
   仅检索 `status = 'active'` 的条目，让 `seed` 条目只出现在内部参考中。
4. 建立复核机制：`review_cycle_days` 到期（默认 180 天）自动提醒复核，
   数据闭环 Agent 的 `compliance_feedback.stale_policies` 会输出待复核清单。

> 本文档中的政策信息不构成法律意见。跨境合规的具体口径随各国立法与平台规则持续变动，
> 必须以最新官方来源与法务意见为准。

## 数据维护责任分工

| 数据 | 维护人 | 频率 |
|---|---|---|
| `glossary_*.csv` 术语库 | 产品运营 + 跨境业务顾问 | 每周（数据闭环 Agent 会给建议） |
| `compliance_rules.csv` 规则库 | 法务 + 产品运营 | 每月复核；新违规模式随时补 |
| `policy_index.csv` 政策索引 | 跨境业务顾问 + 法务 | 每 180 天全量复核；政策变动即时更新 |
| `intent_taxonomy.csv` 标签体系 | 产品运营 + AI 开发 | 按需（慎改，改动会牵连 Schema 与提示词） |

## 改动标签体系时的三处同步（易错点）

修改 `intent_taxonomy.csv` 的 label 时，必须同步修改：

1. `prompts/02-意图情绪Agent-系统提示词.md` 的意图标签表
2. `schemas/intent_emotion.schema.json` 的 `label` / `primary_intent` enum
3. `schemas/main_output.schema.json` 的对应 enum
4. `prompts/03-查询改写Agent-系统提示词.md` 的知识库路由规则（如果新增标签需要新路由）

漏改任何一处都会导致结构化输出校验失败（模型给出的标签不在 enum 里），
表现为该节点持续报错并触发降级。建议用脚本做一致性校验，纳入 CI。
