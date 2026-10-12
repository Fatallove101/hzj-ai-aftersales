---
name: after-sales-qa
name_zh: 售后知识问答与引用
description: RAG grounding、引用原文、无匹配即标记覆盖不足
version: v1.0
domain: knowledge
priority: P0
target_agent: retrieve
action_mode: read
requires_confirmation: false
triggers: [知识库, 检索, 政策, 依据, RAG, retrieve, citation]
discovery_terms: [政策, 规则, 条款, 案例, 术语]
---

## 检索纪律
1. **先查后答**：任何涉及政策、期限、责任、费用的表述，必须先检索
2. **必须引用**：答复中每处政策表述都要能指回 `doc_id`
3. **不编造**：知识库未覆盖时，输出"建议人工核实"，禁止编造政策

## 覆盖度判定
| coverage | 条件 | 后果 |
|---|---|---|
| sufficient | 至少 1 条 policy_kb / platform_rule_kb 命中（score ≥ 0.55） | 可给政策表述 |
| partial | 仅 case_kb / product_kb 命中，或分数 0.4~0.55 | 政策表述需标注"待核实" |
| insufficient | 全部零结果，或 `filters.country == UNKNOWN` | **禁止任何政策承诺**，标记高风险 |

## 时效过滤（强制）
- 只取 `effective_date <= today` 的政策版本
- 引用已废止版本 → 视为无效证据