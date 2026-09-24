# 消费争议证据保全与限时交付 领域约定

系统面向监管询证下的消费争议证据保全。联络员先建案、再冻结清单；材料经过业务复核与隐私批准双门后放行，凭可撤销的授权地址交付。所有持久状态在同一个 SQLite 文件中，所有时间均为 **绝对 ISO-8601 时间戳**——停服重启不重置法定时钟。

## 角色

| 角色 | 标识来源 | 职责 |
|---|---|---|
| 联络员 | `x-actor` | 建案、接入材料、冻结清单、制备交付包 |
| 业务复核人 | `x-actor` | 确认冻结清单完整 |
| 隐私专员 | `x-actor` | 基于同一版本批准字段遮盖 |
| 放行人/法务 | `x-actor` | 在法定时限内放行 |
| 审计人 | `x-actor` | 事后抽查，不改写任何数据 |

**回避规则**：业务复核人、隐私专员、放行人都不能是清单内任一材料或冻结后追加事实的提交人；隐私专员与放行人也不能是包的制备人。违反返回 `SELF_APPROVAL_FORBIDDEN`（403）。

所有写操作与读取敏感包的操作必须带 `x-actor` 头，缺失返回 `VALIDATION`（401）。每个行为写 `access_logs`，材料生命周期事件写 `custody_events`；两张表与 `post_freeze_facts` 一样只追加。

## 案件与时限

```
建案(open) ──冻结清单──> open(frozen) ──放行──> released ──关闭──> closed
   │
   ├── imposeLegalHold：legal_hold=1（可在任何时刻，幂等）
   └── extendDeadline：必须有 reason，且新时限严格晚于当前时限
```

- `deadline_at` 为法定期限（绝对时间）。续期写 `case_deadline_extensions` 并更新案件时限，全过程留痕。
- 放行时若当前时刻晚于 `deadline_at`，返回 `DEADLINE_PASSED`，须先依法续期。
- **法律保全**生效后（`legal_hold=1`，须填理由），常规清理（`POST /admin/cleanup`）只删除「已关闭、无保全、早于水位」的案件；保全案件计入 `skipped_hold_count` 并在日志中列出 ID，绝不删除。

## 材料接入

每份材料有「标识」（`material_records.external_key`，案件内唯一）与「内容版本」（`material_versions`，按 SHA-256 去重）。接入时保存来源摘要、采集时间、来源批次，并写保管链。

| 情形 | 行为 |
|---|---|
| 新标识 | 建立材料，版本为 `current` |
| 同标识 + **同内容哈希**重送（任意批次，含撤回后重发） | 沿用已有版本，仅追加 `REINGEST_DEDUP` 保管链事件，不新增记录 |
| 冻结前同标识 + **不同内容** | 新版本置 `quarantined`，接口返回 `QUARANTINED_VARIANT`（422，带 versionId），等待核查 |
| 冻结后同标识异文 | 版本置 `linked`，追加 `correction` 关联事实 |
| 冻结后新标识 | 版本置 `linked`，追加 `supplement` 关联事实 |

隔离异文的核查（冻结前）：`accept` 将旧 current 置 `superseded`、异文置 current；`reject` 将异文置 `rejected`。冻结后不允许再核查隔离版本（`ALREADY_FROZEN`），异文只能走追加事实。

## 冻结清单（manifest）

- 冻结把当时全部 `current` 版本钉入 `manifest_items`，并对「案件 + 每项标识/类型/版本号/内容哈希」做规范序列化后求 SHA-256，写入 `manifests.digest`。
- 冻结一次性：重复冻结返回 `ALREADY_FROZEN`。
- 冻结后的更正、撤回、补件**只能追加** `post_freeze_facts`（`correction` / `withdrawal` / `supplement`），不改写、不删除清单条目；被撤回材料仍保留在清单中，撤回事实随包交付。
- 追加事实会把尚未放行的包（draft/approved）置为 `superseded`，必须基于新版本重新制备、重新批准。

## 交付门控

```
冻结清单
  └─> POST business-review        （业务复核人，一次性，回避提交人）
        └─> preparePackage         （遮盖方案 + 缺件说明，生成版本与摘要）
              └─> privacy-approval （隐私专员，批准钉住当前包摘要，回避）
                    └─> release     （时限未过；复核、批准、摘要三者匹配）
                          └─> download-links → GET /downloads/:token
```

- 包摘要 `delivery_packages.digest` 由**清单摘要 + 每项交付哈希（原件或遮盖件）+ 全部冻结后事实 + 缺件说明**规范序列化求得；缺件说明（`expected_ref` + `reason`）与稳定摘要同时交付。
- 隐私批准把批准时刻的摘要复制到 `package_privacy_approvals.digest`。放行时重算摘要，与制备摘要、批准摘要三方比对，任何漂移返回 `APPROVAL_VERSION_MISMATCH`。
- 未完成业务复核不能制备包（`BUSINESS_REVIEW_REQUIRED`）；未隐私批准不能放行（`PRIVACY_APPROVAL_REQUIRED`）。
- 复核意见草稿（`review_drafts`）在放行前可反复保存，停服重启不丢失。

## 授权下载

- 仅 `released` 包可签发地址；令牌只存 SHA-256（`token_hash`），明文仅在签发响应中出现一次。
- 下载校验：不存在 `LINK_INVALID`(404)；已撤销 `LINK_REVOKED`(410)；已过期 `LINK_EXPIRED`(410)。
- `POST /packages/:id/revoke` 撤销后旧地址**立即**失效；可按 linkId 撤销单条或整包撤销。撤销不影响已放行包本身，重新签发即可得到新地址。
- 每次签发、成功下载、抽查都写 `access_logs`。

## 事后抽查

`GET /packages/:id/audit` 返回：

- 每项材料的**原始版本**（版本号、原件哈希、原件字节、提交人）；
- 本包的**遮盖版本**（遮盖件哈希、字节、变化说明），无遮盖则为 null；
- 冻结后事实、缺件说明；
- 隐私批准人与批准摘要、制备人、**实际放行人**（`released_by`）与放行时间；
- `digestMatches`：用当前数据重算包摘要与放行摘要比对。

## 机器可读错误码

| 代码 | HTTP | 含义 |
|---|---|---|
| `VALIDATION` | 400/401 | 参数或身份头缺失/非法（缺 `x-actor` 为 401） |
| `CASE_NOT_FOUND` / `MANIFEST_NOT_FOUND` / `PACKAGE_NOT_FOUND` / `MATERIAL_NOT_FOUND` | 404 | 资源不存在 |
| `DEADLINE_PASSED` | 422 | 法定时限已过 |
| `DEADLINE_NOT_LATER` | 422 | 续期时限未晚于当前时限 |
| `REASON_REQUIRED` | 422 | 续期/法律保全缺少理由 |
| `NOT_FROZEN` / `ALREADY_FROZEN` | 422/409 | 清单未冻结 / 已冻结 |
| `QUARANTINED_VARIANT` | 422 | 同标识异文已隔离（details 带 versionId） |
| `BUSINESS_REVIEW_REQUIRED` / `PRIVACY_APPROVAL_REQUIRED` | 422 | 门控未满足 |
| `APPROVAL_VERSION_MISMATCH` | 422 | 批准/放行的不是同一版本 |
| `SELF_APPROVAL_FORBIDDEN` | 403 | 审批了自己提交/制备的材料 |
| `ALREADY_REVIEWED` | 409 | 业务复核已完成 |
| `NOTHING_TO_RELEASE` | 422 | 包状态不允许放行/签发 |
| `LINK_INVALID` | 404 | 下载令牌不存在 |
| `LINK_REVOKED` / `LINK_EXPIRED` | 410 | 地址已撤销/过期 |

错误响应统一为 `{ "error": { "code", "message", "details" } }`。

## HTTP 接口一览

```
POST   /cases                                 建案
GET    /cases/:caseId                         案件状态
GET    /cases/:caseId/detail                  案件+材料版本+续期记录
POST   /cases/:caseId/deadline-extensions     法定时限续期（带理由）
POST   /cases/:caseId/legal-hold              法律保全生效
POST   /cases/:caseId/materials               接入材料（contentBase64）
POST   /materials/:versionId/quarantine-resolution  隔离异文核查 accept|reject
POST   /cases/:caseId/withdrawals             冻结后撤回（追加事实）
POST   /cases/:caseId/manifest/freeze         冻结清单
GET    /cases/:caseId/manifest                查看清单与摘要
PUT    /cases/:caseId/review-drafts           保存未完成意见
GET    /cases/:caseId/review-drafts           意见草稿
POST   /cases/:caseId/business-review         业务复核
POST   /cases/:caseId/packages                制备交付包（redactions + missingItems）
POST   /packages/:packageId/privacy-approval  隐私批准
POST   /packages/:packageId/release           放行
POST   /packages/:packageId/download-links    签发授权地址
POST   /packages/:packageId/revoke            撤销地址
GET    /downloads/:token                      凭令牌取交付包
GET    /packages/:packageId/audit             事后抽查
POST   /admin/cleanup                         常规清理（保全豁免）
GET    /health                                健康检查
```
