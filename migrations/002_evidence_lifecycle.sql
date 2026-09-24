-- 证据保全与限时交付：案件生命周期
-- 所有时间一律以服务端 UTC 墙钟时间（ISO-8601）落库，
-- 法定时钟在创建时即固化为绝对时间，进程停服 / 重启不会重置。

-- 保全案件：联络员先建案，再按争议范围冻结清单
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  -- 争议范围快照：{ description, expected: [{source_key, source_native_id, title}] }
  dispute_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'frozen', 'delivered', 'closed')),
  retention_until TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 法定时限：续期以“旧记录置 superseded + 新记录带理由”的方式留痕，绝不回改 due_at
CREATE TABLE IF NOT EXISTS deadlines (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'regulatory_inquiry',
  due_at TEXT NOT NULL,              -- 绝对到期时间，停服不重置
  reason TEXT,                       -- 续期理由（首次设定时为空）
  extended_from_id TEXT REFERENCES deadlines(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deadlines_case ON deadlines(case_id);

-- 逻辑材料：同一案件下来源标识（source_key + source_native_id）唯一
CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,          -- 邮件附件 / 热线转写 / 商家补件 …
  source_native_id TEXT NOT NULL,    -- 来源系统内标识
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('admitted', 'quarantined')),
  current_record_id TEXT,            -- 当前采信版本（隔离中为空或待核查版本）
  in_frozen_manifest INTEGER NOT NULL DEFAULT 0,
  first_collected_at TEXT NOT NULL,
  UNIQUE (case_id, source_key, source_native_id)
);
CREATE INDEX IF NOT EXISTS idx_items_case ON evidence_items(case_id);

-- 每次接入产生的不可变版本记录（含保管链所需的来源摘要、采集时间）
CREATE TABLE IF NOT EXISTS evidence_records (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  content BLOB NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  source_summary TEXT NOT NULL,      -- 来源摘要（JSON：批次、主题、文件名等）
  content_hash TEXT NOT NULL,        -- sha256(原始内容)
  collected_by TEXT NOT NULL,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_item ON evidence_records(item_id);

-- 保管链事件：接入 / 重送去重 / 异文隔离 / 核查采信 / 冻结后追加
CREATE TABLE IF NOT EXISTS custody_events (
  id TEXT PRIMARY KEY,
  record_id TEXT REFERENCES evidence_records(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'ingested', 'resent_dedup', 'variant_quarantined',
    'quarantine_resolved', 'linked_fact'
  )),
  actor_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custody_item ON custody_events(item_id);

-- 冻结清单：每案一份，冻结后不可变；同时固化当时的缺件说明
CREATE TABLE IF NOT EXISTS frozen_manifests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  scope_snapshot TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,       -- 对全部条目（标识+版本 hash）的稳定摘要
  missing_items TEXT NOT NULL DEFAULT '[]',
  frozen_by TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manifest_entries (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL REFERENCES frozen_manifests(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  record_hash TEXT NOT NULL,
  UNIQUE (manifest_id, item_id)
);

-- 冻结后只能追加的关联事实：更正 / 撤回 / 补件，绝不回改冻结版本
CREATE TABLE IF NOT EXISTS linked_facts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  relates_to_item_id TEXT REFERENCES evidence_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('correction', 'withdrawal', 'supplement')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_facts_case ON linked_facts(case_id);

-- 业务复核意见：不完整意见同样持久化（停服不能丢掉未完成意见）
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES frozen_manifests(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('complete', 'incomplete')),
  note TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_case ON reviews(case_id);

-- 字段遮盖：必须绑定冻结清单版本；只有当前 approved 版本可被交付包引用
CREATE TABLE IF NOT EXISTS redactions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES frozen_manifests(id) ON DELETE CASCADE,
  -- 规则：[{ record_id?, field_path, action }]；field_path 支持摘要字段与正文文本标记
  rules TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'superseded')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redactions_case ON redactions(case_id);

-- 最终交付包：稳定摘要 + 缺件说明 + 实际放行人
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES frozen_manifests(id) ON DELETE CASCADE,
  redaction_id TEXT NOT NULL REFERENCES redactions(id),
  package_hash TEXT NOT NULL,       -- 覆盖原始版本 hash、遮盖变化与缺件说明
  missing_items TEXT NOT NULL DEFAULT '[]',
  released_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packages_case ON packages(case_id);

-- 包内逐材料留痕：冻结的原始版本 vs 实际交付的遮盖版本
CREATE TABLE IF NOT EXISTS package_entries (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  source_record_hash TEXT NOT NULL,
  delivered_hash TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  UNIQUE (package_id, item_id)
);

-- 冻结后追加、随包一并交付的关联事实快照（更正 / 撤回 / 补件）
CREATE TABLE IF NOT EXISTS package_linked_facts (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  linked_fact_id TEXT NOT NULL REFERENCES linked_facts(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  relates_to_item_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  source_record_hash TEXT NOT NULL,
  delivered_hash TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_package_facts_package ON package_linked_facts(package_id);

-- 限时下载授权：只存 token 散列；撤销即时生效
CREATE TABLE IF NOT EXISTS download_grants (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_package ON download_grants(package_id);

-- 法律保全：生效期间常规清理一律跳过相关内容
CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_holds_case ON legal_holds(case_id);

-- 常规清理运行记录（含跳过明细），供抽查
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  detail TEXT NOT NULL DEFAULT '{}', -- { deleted: [caseId...], skipped_holds: [caseId...] }
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 访问 / 操作留痕：所有管控动作与每次下载尝试（含失败原因）
CREATE TABLE IF NOT EXISTS access_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'success',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_access_logs_resource ON access_logs(resource_type, resource_id);
