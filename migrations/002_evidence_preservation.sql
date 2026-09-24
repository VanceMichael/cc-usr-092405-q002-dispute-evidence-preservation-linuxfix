-- 证据保全与限时交付域
-- 所有时间均为绝对时间戳（ISO-8601），停服重启不重置法定时钟。
-- 保管链、冻结后事实、访问日志均为只追加表（由服务层保证不更新/不删除）。

-- 保全案件 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preservation_cases (
  id TEXT PRIMARY KEY,
  dispute_scope TEXT NOT NULL,              -- 争议范围（JSON：批次/商家/争议编号等）
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'released', 'closed')),
  created_by TEXT NOT NULL,                -- 建案联络员
  deadline_at TEXT NOT NULL,               -- 法定时限（绝对时间）
  legal_hold INTEGER NOT NULL DEFAULT 0,   -- 法律保全是否生效
  legal_hold_at TEXT,
  legal_hold_reason TEXT,
  frozen_at TEXT,
  released_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_deadline_extensions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  new_deadline_at TEXT NOT NULL,           -- 续期后的时限
  reason TEXT NOT NULL,                    -- 续期理由（必填）
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extensions_case ON case_deadline_extensions(case_id);

-- 材料：同一标识一行身份，内容按版本沉淀 ------------------------------
CREATE TABLE IF NOT EXISTS material_records (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  external_key TEXT NOT NULL,              -- 来源侧标识（邮件/转写/补件编号）
  source_type TEXT NOT NULL                -- email_attachment | hotline_transcript | merchant_supplement
    CHECK (source_type IN ('email_attachment', 'hotline_transcript', 'merchant_supplement')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, external_key)
);

CREATE TABLE IF NOT EXISTS material_versions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES material_records(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,              -- 原始内容 SHA-256
  content BLOB NOT NULL,
  media_type TEXT,
  source_summary TEXT NOT NULL,            -- 来源摘要
  collected_at TEXT NOT NULL,              -- 采集时间
  received_batch TEXT,                     -- 接入批次
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('current', 'quarantined', 'superseded', 'rejected', 'linked')),
  created_at TEXT NOT NULL,
  UNIQUE (material_id, version_no),
  UNIQUE (material_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_versions_material ON material_versions(material_id);
CREATE INDEX IF NOT EXISTS idx_versions_hash ON material_versions(material_id, content_hash);

-- 保管链（只追加） ----------------------------------------------------
CREATE TABLE IF NOT EXISTS custody_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES material_records(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES material_versions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custody_case ON custody_events(case_id);

-- 冻结清单 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES preservation_cases(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,                    -- 清单规范摘要
  frozen_by TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manifest_items (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES material_records(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
  UNIQUE (manifest_id, material_id)
);

-- 冻结后的更正/撤回/补件：只能追加为关联事实 --------------------------
CREATE TABLE IF NOT EXISTS post_freeze_facts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL
    CHECK (fact_type IN ('correction', 'withdrawal', 'supplement')),
  material_id TEXT REFERENCES material_records(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES material_versions(id) ON DELETE CASCADE,
  external_ref TEXT,                       -- 补件自带的外部标识
  summary TEXT NOT NULL,
  content_hash TEXT,
  content BLOB,
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_manifest ON post_freeze_facts(manifest_id);

-- 业务复核（清单完整性） ----------------------------------------------
CREATE TABLE IF NOT EXISTS manifest_business_reviews (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL UNIQUE REFERENCES manifests(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

-- 未完成意见草稿：跨停服保留 ------------------------------------------
CREATE TABLE IF NOT EXISTS review_drafts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('business', 'privacy')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, stage, author)
);

-- 交付包（按版本承载遮盖方案） ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_packages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  digest TEXT NOT NULL,                    -- 包规范摘要（原件+事实+遮盖+缺件）
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'approved', 'released', 'superseded')),
  prepared_by TEXT NOT NULL,
  released_by TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version_no)
);

CREATE TABLE IF NOT EXISTS package_redactions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES delivery_packages(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES material_records(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
  redacted_hash TEXT NOT NULL,
  redacted_content BLOB NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  UNIQUE (package_id, material_id)
);

CREATE TABLE IF NOT EXISTS package_missing_items (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES delivery_packages(id) ON DELETE CASCADE,
  expected_ref TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- 隐私批准钉住批准时刻的包摘要（只批准同一版本） ----------------------
CREATE TABLE IF NOT EXISTS package_privacy_approvals (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL UNIQUE REFERENCES delivery_packages(id) ON DELETE CASCADE,
  officer TEXT NOT NULL,
  digest TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

-- 授权下载地址 --------------------------------------------------------
CREATE TABLE IF NOT EXISTS download_links (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES preservation_cases(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES delivery_packages(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);

-- 访问留痕（只追加） --------------------------------------------------
CREATE TABLE IF NOT EXISTS access_logs (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES preservation_cases(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_case ON access_logs(case_id);

-- 常规清理运行记录 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  older_than TEXT NOT NULL,
  deleted_count INTEGER NOT NULL,
  skipped_hold_count INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
