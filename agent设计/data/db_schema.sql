-- =====================================================================
-- 汉正街跨境售后 AI 话术助手 · 结构化数据库建表脚本
-- 用途：千帆「数据库节点」的数据底座。种子数据见同目录 CSV。
-- 说明：语法按 MySQL 8.0 编写；若使用千帆内置数据库或其他引擎，
--       字段类型可按「文本/数值/日期/布尔」四类做等价映射。
-- ⚠️ 合规相关表（compliance_rules / policy_index）上线前须经法务确认。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 商户与商品（业务主数据）
-- ---------------------------------------------------------------------

CREATE TABLE merchants (
  merchant_id        VARCHAR(32)   NOT NULL COMMENT '商户ID',
  merchant_name      VARCHAR(128)  NOT NULL COMMENT '商户名称',
  main_categories    VARCHAR(256)  NULL     COMMENT '主营品类，逗号分隔，如 dress,knitwear',
  default_lang       VARCHAR(8)    NULL     COMMENT '默认对外语言',
  plan_level         VARCHAR(16)   NULL     COMMENT '套餐：free / pro / enterprise',
  created_at         DATETIME      NULL,
  PRIMARY KEY (merchant_id)
) COMMENT='商户表';

CREATE TABLE products (
  sku                VARCHAR(64)   NOT NULL COMMENT 'SKU',
  merchant_id        VARCHAR(32)   NOT NULL,
  product_name_zh    VARCHAR(256)  NULL     COMMENT '商品中文名',
  product_name_en    VARCHAR(256)  NULL,
  category           VARCHAR(32)   NULL     COMMENT '品类英文小写：dress/knitwear/...',
  fabric_composition VARCHAR(256)  NULL     COMMENT '面料成分，须与吊牌一致',
  care_instructions  VARCHAR(512)  NULL     COMMENT '洗涤保养说明',
  color_options      VARCHAR(256)  NULL,
  cost_price         DECIMAL(12,2) NULL,
  PRIMARY KEY (sku),
  KEY idx_products_merchant (merchant_id),
  KEY idx_products_category (category)
) COMMENT='商品表（产品知识库的结构化来源）';

CREATE TABLE size_charts (
  id                 BIGINT        NOT NULL AUTO_INCREMENT,
  sku                VARCHAR(64)   NOT NULL,
  size_label         VARCHAR(16)   NOT NULL COMMENT '如 S/M/L 或 EU38/US6',
  bust_cm            DECIMAL(6,2)  NULL,
  waist_cm           DECIMAL(6,2)  NULL,
  hip_cm             DECIMAL(6,2)  NULL,
  length_cm          DECIMAL(6,2)  NULL,
  height_range_cm    VARCHAR(32)   NULL COMMENT '适用身高区间',
  weight_range_kg    VARCHAR(32)   NULL,
  note               VARCHAR(256)  NULL,
  PRIMARY KEY (id),
  KEY idx_size_sku (sku)
) COMMENT='尺码表（尺码类咨询的关键依据）';

-- ---------------------------------------------------------------------
-- 2. 订单、物流、客户（个性化与转人工判定的依据）
-- ---------------------------------------------------------------------

CREATE TABLE orders (
  order_id           VARCHAR(64)   NOT NULL COMMENT '平台订单号',
  merchant_id        VARCHAR(32)   NOT NULL,
  customer_id        VARCHAR(64)   NULL,
  sku                VARCHAR(64)   NULL,
  quantity           INT           NULL,
  amount             DECIMAL(12,2) NULL,
  currency           VARCHAR(8)    NULL,
  channel            VARCHAR(32)   NULL COMMENT 'tiktok_shop/amazon/temu/shopee/independent_site',
  country            VARCHAR(8)    NULL COMMENT 'ISO 二字码，跨境场景关键字段',
  order_status       VARCHAR(32)   NULL COMMENT 'paid/shipped/delivered/closed/refunded',
  paid_at            DATETIME      NULL,
  shipped_at         DATETIME      NULL,
  delivered_at       DATETIME      NULL,
  promised_delivery  DATE          NULL COMMENT '承诺到达日，用于判定延误',
  PRIMARY KEY (order_id),
  KEY idx_orders_merchant (merchant_id),
  KEY idx_orders_country (country)
) COMMENT='订单表';

CREATE TABLE shipments (
  id                 BIGINT        NOT NULL AUTO_INCREMENT,
  order_id           VARCHAR(64)   NOT NULL,
  tracking_no        VARCHAR(64)   NULL,
  carrier            VARCHAR(64)   NULL,
  status             VARCHAR(32)   NULL COMMENT 'in_transit/delivered/exception/lost',
  last_event         VARCHAR(256)  NULL,
  last_event_at      DATETIME      NULL,
  exception_reason   VARCHAR(256)  NULL COMMENT '清关滞留、地址异常等',
  PRIMARY KEY (id),
  KEY idx_ship_order (order_id)
) COMMENT='物流轨迹表';

CREATE TABLE customers (
  customer_id        VARCHAR(64)   NOT NULL,
  country            VARCHAR(8)    NULL,
  lang               VARCHAR(8)    NULL,
  vip_level          VARCHAR(16)   NULL COMMENT 'normal / silver / gold',
  order_count        INT           NULL     COMMENT '历史订单数，复购判断依据',
  history_disputes   INT           NULL     COMMENT '历史争议次数，重复投诉判断依据',
  first_order_at     DATETIME      NULL,
  -- 注意：严禁存储银行卡、证件号等敏感支付信息
  privacy_note       VARCHAR(128)  NULL,
  PRIMARY KEY (customer_id),
  KEY idx_customers_country (country)
) COMMENT='客户画像表（脱敏后）';

CREATE TABLE after_sales_cases (
  case_id            VARCHAR(64)   NOT NULL,
  order_id           VARCHAR(64)   NULL,
  merchant_id        VARCHAR(32)   NULL,
  primary_intent     VARCHAR(32)   NULL,
  resolution         VARCHAR(32)   NULL COMMENT 'refund/exchange/partial_refund/rejected/closed',
  shipping_payer     VARCHAR(16)   NULL COMMENT 'merchant / customer / platform',
  escalated_to_platform TINYINT(1) NULL COMMENT '是否升级到平台介入',
  platform_result    VARCHAR(32)   NULL COMMENT 'win/lose/settled',
  satisfaction       TINYINT       NULL COMMENT '1-5',
  created_at         DATETIME      NULL,
  closed_at          DATETIME      NULL,
  PRIMARY KEY (case_id),
  KEY idx_case_order (order_id)
) COMMENT='售后工单表（数据闭环的结果标签来源）';

-- ---------------------------------------------------------------------
-- 3. 术语库（翻译 Agent 与话术生成 Agent 共用）
-- ---------------------------------------------------------------------

CREATE TABLE glossary (
  term_id            VARCHAR(16)   NOT NULL,
  term_zh            VARCHAR(128)  NOT NULL,
  term_en            VARCHAR(128)  NULL,
  term_es            VARCHAR(128)  NULL,
  term_de            VARCHAR(128)  NULL,
  term_fr            VARCHAR(128)  NULL,
  category           VARCHAR(32)   NULL,
  note               VARCHAR(256)  NULL,
  status             VARCHAR(16)   NULL DEFAULT 'active' COMMENT 'active/deprecated',
  PRIMARY KEY (term_id),
  KEY idx_glossary_zh (term_zh)
) COMMENT='服装跨境术语库（种子数据见 glossary_zh_en_es_de_fr.csv）';

-- ---------------------------------------------------------------------
-- 4. 合规规则库（合规校验 Agent 的核心数据）
-- ---------------------------------------------------------------------

CREATE TABLE compliance_rules (
  rule_id            VARCHAR(16)   NOT NULL COMMENT '规则编号，如 R001',
  category           VARCHAR(32)   NOT NULL COMMENT 'promise/privacy/platform_rule/advertising/discrimination/cross_border',
  severity           VARCHAR(16)   NOT NULL COMMENT 'block / revise / warn',
  title              VARCHAR(256)  NOT NULL,
  pattern            TEXT          NULL     COMMENT '正则表达式，供代码节点做硬拦截',
  match_mode         VARCHAR(16)   NOT NULL DEFAULT 'violation' COMMENT 'violation=pattern命中即违规；obligation=pattern仅表示规则适用，是否违规须由模型判断（正向义务类规则）',
  description        TEXT          NULL     COMMENT '判定说明',
  applies_country     VARCHAR(512) NULL     COMMENT '适用国家，| 分隔；SCOPE_GLOBAL 表示全球',
  applies_platform   VARCHAR(256)  NULL,
  revise_hint        VARCHAR(512)  NULL     COMMENT '修订建议',
  effective_date     DATE          NULL,
  verified_by        VARCHAR(64)   NULL     COMMENT '法务确认人',
  verified_date      DATE          NULL,
  status             VARCHAR(16)   NULL DEFAULT 'seed' COMMENT 'seed/active/deprecated',
  PRIMARY KEY (rule_id),
  KEY idx_rules_category (category),
  KEY idx_rules_severity (severity)
) COMMENT='合规规则库（种子数据见 compliance_rules.csv；上线前须法务逐条确认）';

CREATE TABLE policy_index (
  doc_id             VARCHAR(32)   NOT NULL,
  country            VARCHAR(8)    NULL     COMMENT 'ISO 二字码；EU 表示欧盟统一规则',
  region             VARCHAR(8)    NULL     COMMENT 'EU / GB / NA 等',
  policy_name        VARCHAR(256)  NULL,
  policy_name_local  VARCHAR(256)  NULL,
  key_rule           TEXT          NULL     COMMENT '核心口径摘要',
  return_window_days INT           NULL     COMMENT '退货窗口天数；NA 表示不适用',
  return_shipping_payer VARCHAR(64) NULL    COMMENT '运费承担方',
  effective_date     DATE          NULL     COMMENT '生效日期，用于时效过滤',
  source_url         VARCHAR(512)  NULL     COMMENT '官方来源链接',
  applies_platform   VARCHAR(256)  NULL,
  review_cycle_days  INT           NULL DEFAULT 180 COMMENT '复核周期，超期触发法务复核',
  verified_by        VARCHAR(64)   NULL,
  verified_date      DATE          NULL,
  status             VARCHAR(16)   NULL DEFAULT 'seed',
  PRIMARY KEY (doc_id),
  KEY idx_policy_country (country),
  KEY idx_policy_effective (effective_date)
) COMMENT='各国政策索引（时效过滤的关键表；检索必须带 effective_date <= today）';

-- ---------------------------------------------------------------------
-- 5. 数据闭环（异步 Agent 的数据来源）
-- ---------------------------------------------------------------------

CREATE TABLE qa_logs (
  id                 BIGINT        NOT NULL AUTO_INCREMENT,
  trace_id           VARCHAR(64)   NOT NULL,
  session_id         VARCHAR(64)   NULL,
  merchant_id        VARCHAR(32)   NULL,
  order_id           VARCHAR(64)   NULL,
  channel            VARCHAR(32)   NULL,
  -- 脱敏后的文本：PII 已用占位符替换，禁止存原文
  customer_text_masked  TEXT       NULL,
  customer_text_zh   TEXT          NULL     COMMENT '中文译文',
  primary_intent     VARCHAR(32)   NULL,
  intents_json       TEXT          NULL,
  emotion_polarity   VARCHAR(16)   NULL,
  emotion_intensity  TINYINT       NULL,
  urgency            VARCHAR(16)   NULL,
  risk_flags_json    TEXT          NULL,
  queries_json       TEXT          NULL,
  coverage           VARCHAR(16)   NULL,
  evidence_json      TEXT          NULL,
  candidates_json    TEXT          NULL,
  compliance_json    TEXT          NULL,
  recommended_id     VARCHAR(8)    NULL,
  -- 客服操作：数据闭环的核心标签
  action             VARCHAR(16)   NULL     COMMENT 'accept / edit / ignore',
  final_text_sent    TEXT          NULL     COMMENT '客服实际发出的文本',
  edit_distance      DECIMAL(6,4)  NULL     COMMENT '与推荐话术的相似度，用于区分微调与重写',
  need_human         TINYINT(1)    NULL,
  escalate_reason    VARCHAR(64)   NULL,
  latency_ms         INT           NULL,
  degraded_nodes     VARCHAR(256)  NULL,
  created_at         DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_qa_trace (trace_id),
  KEY idx_qa_intent (primary_intent),
  KEY idx_qa_created (created_at)
) COMMENT='问答与操作日志（数据闭环 Agent 的主输入；文本必须脱敏后写入）';

CREATE TABLE feedback (
  id                 BIGINT        NOT NULL AUTO_INCREMENT,
  trace_id           VARCHAR(64)   NULL,
  case_id            VARCHAR(64)   NULL,
  feedback_type      VARCHAR(32)   NULL     COMMENT 'satisfaction / review / repurchase / complaint',
  satisfaction       TINYINT       NULL     COMMENT '1-5',
  review_stars       TINYINT       NULL,
  comment_masked     VARCHAR(512)  NULL     COMMENT '脱敏后的评价文本',
  created_at         DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_feedback_trace (trace_id)
) COMMENT='客户反馈表（数据闭环的结果侧标签）';

CREATE TABLE optimization_actions (
  action_id          VARCHAR(32)   NOT NULL COMMENT '如 OPT-2026W01-001',
  period             VARCHAR(32)   NULL,
  priority           VARCHAR(8)    NULL     COMMENT 'P0/P1/P2',
  category           VARCHAR(32)   NULL     COMMENT 'knowledge_base/prompt/rule_base/glossary/policy_review/ux',
  target             VARCHAR(256)  NULL     COMMENT '具体到文件与条目',
  problem            TEXT          NULL,
  suggestion         TEXT          NULL,
  evidence_trace_ids VARCHAR(512)  NULL,
  expected_impact    VARCHAR(256)  NULL,
  owner              VARCHAR(64)   NULL,
  status             VARCHAR(16)   NULL DEFAULT 'open' COMMENT 'open/in_progress/done/rejected',
  created_at         DATETIME      NULL,
  closed_at          DATETIME      NULL,
  PRIMARY KEY (action_id)
) COMMENT='优化建议生命周期表（避免建议反复出现却无人执行）';

-- =====================================================================
-- 检索时必须遵守的过滤规则（写进数据库节点的 WHERE 子句）
-- =====================================================================
-- 1) 政策类检索必须限制时效，避免命中已废止版本：
--    SELECT ... FROM policy_index
--     WHERE (country = :country OR country = 'EU')
--       AND effective_date <= CURDATE()
--       AND status = 'active'
--     ORDER BY effective_date DESC;
--
-- 2) 合规规则按国家与平台取适用集：
--    注意：正则硬拦截只跑 match_mode = 'violation' 的规则；
--          match_mode = 'obligation' 的规则（如欧盟14天告知义务）pattern 只是"适用性触发词"，
--          是否违规必须交给模型判断，否则任何提到"退货/退款"的合规话术都会被误杀。
--    SELECT ... FROM compliance_rules
--     WHERE status IN ('active','seed')
--       AND (applies_country LIKE CONCAT('%', :country, '%') OR applies_country = 'SCOPE_GLOBAL')
--     ORDER BY FIELD(severity,'block','revise','warn');
--
-- 3) 术语预匹配（翻译 Agent 前置）：
--    SELECT * FROM glossary
--     WHERE status = 'active' AND :text LIKE CONCAT('%', term_zh, '%');
-- =====================================================================
