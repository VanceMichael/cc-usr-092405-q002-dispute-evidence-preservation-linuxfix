# 消费争议证据保全与限时交付

面向 48 小时监管询证的证据仓。系统只持久化完成争议交付所需的事实，
所有状态进入同一 SQLite 文件；来源事件、保管链、冻结清单、复核意见、
遮盖版本与交付包分别留痕，已固化的内容一律不可回改，只能追加关联事实。

## 角色与职责（四岗分离 + 管理）

| 角色 | 头标识 | 职责 |
| --- | --- | --- |
| 联络员 `liaison` | `x-actor-roles` | 建案、采集接入、冻结清单、追加更正/撤回/补件 |
| 业务复核人 `reviewer` | | 异文核查、确认清单是否完整 |
| 隐私专员 `privacy_officer` | | 基于冻结版本批准字段遮盖 |
| 放行人 `releaser` | | 放行交付包、签发/收回下载授权 |
| 管理员 `admin` | | 法律保全、常规清理 |

所有请求带 `x-actor-id` 与逗号分隔的 `x-actor-roles`。**任何人都不能审批
自己提交的材料**——回避校验按“人”而非角色：审批人不得是清单内任一材料
的采集人，覆盖复核、遮盖批准与放行三道关口。

## 生命周期与不变量

1. **先建案后冻结**：案件携带争议范围 `scope.expected`（来源标识清单）。
2. **接入留痕**：每次接入保存来源摘要、采集时间、采集人与 sha256 内容摘要；
   - 同内容重送（任意批次）→ 命中既有记录，记 `resent_dedup`，不产生新版本；
   - 同一来源标识出现异文 → 新版本入库但材料置 `quarantined`，等待复核人
     核查采信或驳回；被撤回过的材料不会丢失，也不会被仓促采信。
3. **冻结不可变**：联络员按争议范围冻结一份清单，固化 `manifest_hash` 与
   缺件说明（未采集 / 隔离待核查分别注明）。冻结后：
   - 不能再次冻结，普通接入一律拒绝（`FROZEN_APPEND_ONLY`）；
   - 更正、撤回、补件只能以 `linked_facts` 追加，冻结版本与摘要不变，
     追加事实随交付包一并交付。
4. **双岗审批**：业务复核给出 complete/incomplete（incomplete 意见也持久化，
   停服不丢）；隐私专员的遮盖规则必须绑定当前冻结版本（同版本批准）；
   只有复核完整 + 遮盖批准 + 放行人回避通过，才能出具交付包。
5. **交付包**：`package_hash` 对“原始版本摘要 + 遮盖变化 + 缺件说明”做
   确定性哈希（键排序序列化），同状态重放哈希一致；包内逐材料留存
   原始 hash、交付 hash 与变更字段，并记录实际放行人。
6. **限时下载**：放行人签发一次性 token（库存仅 sha256 散列）与到期时间；
   撤销即时生效，过期/无效/已撤销一律拒绝；每次尝试（含失败原因）留痕。
   下载时复算交付字节哈希，与放行摘要不符则拒绝（`PACKAGE_INTEGRITY_FAILED`）。
7. **法定时钟**：`due_at` 在设定时固化为绝对 UTC 时间；续期必须带理由，
   旧记录置 `superseded` 且不回改。进程停服/重启既不重置时钟，也不丢失
   隔离版本与未完成意见。
8. **法律保全优先于清理**：常规清理仅删除过保留期且无生效保全的案件，
   被保全案件整体跳过并在 `cleanup_runs` 记录；解除保全后才可清理。
9. **全程留痕**：管控动作、下载尝试与抽查访问写入 `access_logs`。

## 接口

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/cases` | liaison | 建案（case_no/title/scope） |
| GET | `/cases/:id` | 任意 | 案件状态与活动时限（含 overdue） |
| PUT | `/cases/:id/deadline` | liaison/admin | 设定/带理由续期法定时限 |
| POST | `/cases/:id/ingest` | liaison | 接入（去重/异文隔离） |
| POST | `/items/:id/quarantine-resolution` | reviewer/admin | 异文核查 admit/reject |
| POST | `/cases/:id/freeze` | liaison | 冻结清单 + 缺件说明 |
| POST | `/cases/:id/linked-facts` | liaison | 追加 correction/withdrawal/supplement |
| POST | `/cases/:id/reviews` | reviewer | 完整性复核（回避采集人） |
| POST | `/cases/:id/redactions` | privacy_officer | 批准遮盖规则（绑定冻结版本） |
| POST | `/cases/:id/packages` | releaser | 放行交付包 |
| POST | `/packages/:id/grants` | releaser | 签发限时下载 token |
| POST | `/grants/:id/revoke` | releaser/admin | 收回授权（旧地址立即失效） |
| GET | `/downloads/:token` | 任意 | 凭 token 取包（留痕） |
| POST | `/cases/:id/legal-holds` | admin | 施加法律保全 |
| POST | `/legal-holds/:id/release` | admin | 解除法律保全 |
| POST | `/admin/cleanup` | admin | 常规清理（跳过保全中内容） |
| GET | `/packages/:id/audit` | 任意 | 抽查：原始版本/遮盖变化/放行人/授权/留痕 |
| GET | `/cases/:id/access-logs` | reviewer/admin/releaser | 案件访问留痕 |

错误返回 `{ "error": { "code", "message", "details" } }`，`code` 为稳定的
机器可读代码（如 `SELF_APPROVAL_FORBIDDEN`、`FROZEN_APPEND_ONLY`、
`REDACTION_VERSION_MISMATCH`、`DOWNLOAD_DENIED`、`ACTIVE_LEGAL_HOLD`）。

遮盖规则 `field_path` 以材料 JSON 为根的点分路径（如 `consumer.phone`），
命名字段以固定占位符 `【已遮盖】` 替换，处理过程确定性可复算。

## 运行

```bash
npm ci
npm run db:migrate   # DATABASE_PATH 可覆盖默认 data/consumer_disputes.sqlite3
npm test
npm run dev
```
