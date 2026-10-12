---
name: offline-fallback
name_zh: 离线兜底话术
description: 不依赖任何外部 API 的本地兜底生成，保证链路永不空手
version: v1.0
domain: runtime
priority: P2
target_agent: generate
action_mode: draft
requires_confirmation: true
triggers: [兜底, 降级, 离线, fallback, offline]
discovery_terms: [超时, 失败, 无依据]
---

## 触发条件
- 模型调用失败或超时
- `coverage == insufficient`（检索无据）
- 上游任一关键节点降级

## 兜底原则
1. **只做两件事**：接住情绪 + 给出下一步
2. **禁止出现**：政策期限、赔偿金额、责任归属、运费承担方
3. **必须标记**：`unsupported = true`，界面明确提示"未匹配到知识依据"

## 兜底模板（五语言见 data/fallback_templates.md）
| 意图 | 兜底要点 |
|---|---|
| 退款/质量 | 致歉 + 已记录 + 请提供实物照片 |
| 物流 | 感谢耐心 + 正在查询 + 会同步进展 |
| 尺码/换货 | 已记录 + 正在核对 + 稍后给明确方式 |
| 差评/服务 | 致歉 + 已上报 + 专人跟进 |
| 其他 | 已收到 + 正在核实 + 尽快回复 |