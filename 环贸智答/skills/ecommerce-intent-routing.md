---
name: ecommerce-intent-routing
name_zh: 电商意图识别与工单路由
description: 9 类核心意图 + 工单分派组 + SLA 时限 + 风险标志
version: v1.0
domain: order
priority: P0
target_agent: intent
action_mode: read
requires_confirmation: false
triggers: [意图, 分类, 分派, 路由, intent, routing, SLA]
discovery_terms: [退款, 换货, 物流, 质量, 差评, 复购]
---

## 9 类核心意图 → 分派组 → SLA

| 意图 | 分派组 | SLA | 风险标志 |
|---|---|---|---|
| refund 退款 | 售后组 | 4h | 超 ¥500 升级主管 |
| exchange 换货 | 售后组 | 8h | — |
| logistics 物流 | 物流组 | 2h | 超 15 天加 `platform_intervention_risk` |
| quality_defect 质量 | 质检组 | 4h | 涉童装加 `legal_risk` |
| color_diff 色差 | 售后组 | 8h | — |
| sizing 尺码 | 售前组 | 12h | — |
| negative_review 差评 | 主管组 | 1h | 强制 `public_opinion_risk` |
| repurchase 复购 | 销售组 | 24h | — |
| customs 关税 | 合规组 | 6h | — |

## 判定规则
1. 多意图时 `primary_intent` 取**客户真正想要的结果**
2. 命中 `chargeback_risk` / `platform_intervention_risk` / `legal_risk` 时，紧急度一律提升为 `critical`
3. 分不清时倾向**更高的紧急度**——漏判代价远高于误判