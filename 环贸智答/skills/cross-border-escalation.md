---
name: cross-border-escalation
name_zh: 跨境合规与危机升级
description: 各国政策告知义务、平台规则红线、危机升级路径
version: v1.0
domain: after_sales
priority: P1
target_agent: compliance
action_mode: read
requires_confirmation: true
triggers: [合规, 政策, 法规, 升级, 风险, compliance, escalation]
discovery_terms: [欧盟, 关税, 隐私, 歧视, 平台规则]
---

## 各国法定告知义务（涉及退货场景必须体现）
| 国家/地区 | 必须告知 |
|---|---|
| 欧盟（DE/FR/ES/IT…） | 14 天无理由退货权 |
| 德国 | Widerrufsrecht（撤回权） |
| 英国 | 取消权 14 天 / 质量问题 30 天拒收权 |
| 美国 | 不得虚构资质认证 |

## 三条不可越过的红线
1. **不得要求客户承担依法应由商家承担的质量问题退货运费**（欧盟/英国尤其严格）
2. **不得替平台下判罚结论**
3. **不得在无认定依据前下责任结论**（"确认是运输造成的"）

## 危机升级路径
| 触发 | 动作 |
|---|---|
| `legal_risk` | 停止自动建议，由主管介入 |
| `platform_intervention_risk` | 整理证据包（会话+物流+政策依据） |
| `public_opinion_risk` | 1 小时内响应，禁止对抗性表述 |
| 涉童装安全 | 最高优先级，按召回流程处理 |