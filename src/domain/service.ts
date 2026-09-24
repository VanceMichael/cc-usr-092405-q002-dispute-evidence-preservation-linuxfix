import type Database from "better-sqlite3";
import { getSharedRawDatabase } from "../database.js";
import type { Actor, Role } from "./actors.js";
import { hasRole } from "./actors.js";
import {
  type Clock,
  newDownloadToken,
  newId,
  nowIso,
  parseJsonArray,
  sha256,
  stableHash,
  stableStringify,
  systemClock,
} from "./crypto.js";
import { DomainError, Errors } from "./errors.js";

export interface ScopeItem {
  source_key: string;
  source_native_id: string;
  title?: string;
}
export interface DisputeScope {
  description: string;
  expected: ScopeItem[];
}
export interface RedactionRule {
  field_path: string; // 以负载 JSON 为根的点分路径
  action?: "mask";
}

interface IngestInput {
  source_key: string;
  source_native_id: string;
  title?: string;
  content: string; // UTF-8 原文
  media_type?: string;
  source_summary: unknown;
}

const row = <T>(stmt: Database.Statement, ...params: unknown[]): T | undefined =>
  stmt.get(...params) as T | undefined;
const rows = <T>(stmt: Database.Statement, ...params: unknown[]): T[] =>
  stmt.all(...params) as T[];

export class EvidenceService {
  private readonly db: Database.Database;

  constructor(
    db?: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {
    this.db = db ?? getSharedRawDatabase();
  }

  private now(): string {
    return nowIso(this.clock);
  }

  // ── 通用辅助 ──────────────────────────────────────────────────────────

  private requireRole(actor: Actor, ...roles: Role[]): void {
    if (!hasRole(actor, ...roles)) throw Errors.forbiddenRole(roles);
  }

  private getCaseOrThrow(caseId: string) {
    const caseRow = row<any>(this.db.prepare("SELECT * FROM cases WHERE id = ?"), caseId);
    if (!caseRow) throw Errors.notFound("case");
    return caseRow;
  }

  private log(
    actor: Actor | string,
    action: string,
    resourceType: string,
    resourceId: string,
    outcome: "success" | "denied" | "error" = "success",
    detail: unknown = {},
  ): void {
    const actorId = typeof actor === "string" ? actor : actor.id;
    this.db
      .prepare(
        `INSERT INTO access_logs (id, actor_id, action, resource_type, resource_id, outcome, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), actorId, action, resourceType, resourceId, outcome, JSON.stringify(detail), this.now());
  }

  /** 任何人都不能审批自己提交的材料：审批人不得是清单内任一材料的采集人。 */
  private assertNotSubmitter(actor: Actor, manifestId: string): void {
    const submitted = row<{ n: number }>(
      this.db.prepare(
        `SELECT COUNT(*) AS n FROM manifest_entries me
         JOIN evidence_records er ON er.id = me.record_id
         WHERE me.manifest_id = ? AND er.collected_by = ?`,
      ),
      manifestId,
      actor.id,
    );
    if ((submitted?.n ?? 0) > 0) throw Errors.selfApproval();
  }

  // ── 1. 建案与法定时钟 ─────────────────────────────────────────────────

  createCase(
    actor: Actor,
    input: { case_no: string; title: string; scope: DisputeScope; retention_until?: string },
  ) {
    this.requireRole(actor, "liaison");
    if (!input.scope || !Array.isArray(input.scope.expected)) {
      throw Errors.validation("dispute_scope.expected 必须为数组");
    }
    const id = newId();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO cases (id, case_no, title, dispute_scope, status, retention_until, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(id, input.case_no, input.title, stableStringify(input.scope), input.retention_until ?? null, actor.id, at, at);
    this.log(actor, "case.create", "case", id, "success", { case_no: input.case_no });
    return this.getCaseOrThrow(id);
  }

  /** 设定或续期法定时限：续期必须带理由，旧时限置 superseded，绝不回改。 */
  setDeadline(actor: Actor, caseId: string, input: { due_at: string; reason?: string }) {
    this.requireRole(actor, "liaison", "admin");
    this.getCaseOrThrow(caseId);
    const dueAt = Date.parse(input.due_at);
    if (Number.isNaN(dueAt)) throw Errors.validation("due_at 必须为 ISO-8601 时间");

    const active = row<any>(
      this.db.prepare("SELECT * FROM deadlines WHERE case_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"),
      caseId,
    );
    if (active && !input.reason?.trim()) throw Errors.extensionReasonRequired();

    const id = newId();
    const at = this.now();
    const tx = this.db.transaction(() => {
      if (active) {
        this.db.prepare("UPDATE deadlines SET status = 'superseded' WHERE id = ?").run(active.id);
      }
      this.db
        .prepare(
          `INSERT INTO deadlines (id, case_id, kind, due_at, reason, extended_from_id, status, created_by, created_at)
           VALUES (?, ?, 'regulatory_inquiry', ?, ?, ?, 'active', ?, ?)`,
        )
        .run(id, caseId, input.due_at, input.reason ?? null, active ? active.id : null, actor.id, at);
      this.db.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").run(at, caseId);
    });
    tx();
    this.log(actor, active ? "deadline.extend" : "deadline.set", "case", caseId, "success", {
      due_at: input.due_at,
      reason: input.reason ?? null,
      superseded: active?.id ?? null,
    });
    return row(this.db.prepare("SELECT * FROM deadlines WHERE id = ?"), id);
  }

  getCaseStatus(caseId: string) {
    const caseRow = this.getCaseOrThrow(caseId);
    const deadline = row<any>(
      this.db.prepare("SELECT * FROM deadlines WHERE case_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"),
      caseId,
    );
    return {
      case: caseRow,
      deadline: deadline
        ? { ...deadline, overdue: Date.parse(deadline.due_at) <= this.clock().getTime() }
        : null,
    };
  }

  // ── 2. 接入采集：来源摘要、采集时间、保管链、去重、异文隔离 ──────────

  /**
   * @returns { outcome: 'ingested' | 'dedup' | 'quarantined' }
   * 同内容重送沿用已有记录；同一标识异文隔离待核查。
   */
  ingest(actor: Actor, caseId: string, input: IngestInput, opts: { allowNewAfterFreeze?: boolean; asLinkedFact?: boolean } = {}) {
    this.requireRole(actor, "liaison");
    const caseRow = this.getCaseOrThrow(caseId);
    if (!input.source_key || !input.source_native_id) throw Errors.validation("缺少来源标识");
    if (input.source_summary === undefined) throw Errors.validation("接入必须保存来源摘要");

    const content = Buffer.from(input.content ?? "", "utf8");
    const hash = sha256(content);
    const at = this.now();

    const result = (() => {
      // 冻结闸门优先：冻结后任何更正 / 撤回 / 补件都只能走追加关联事实，
      // 不允许以普通接入（即便内容与既有版本相同）绕过。
      if (caseRow.status !== "open" && !opts.allowNewAfterFreeze) {
        throw new DomainError(
          "FROZEN_APPEND_ONLY",
          "清单冻结后的新补件只能以追加关联事实方式接入",
          { item: { source_key: input.source_key, source_native_id: input.source_native_id } },
        );
      }

      const existing = row<any>(
        this.db.prepare("SELECT * FROM evidence_items WHERE case_id = ? AND source_key = ? AND source_native_id = ?"),
        caseId,
        input.source_key,
        input.source_native_id,
      );

      if (existing) {
        // 同内容重送（任一既有版本 hash 命中）→ 沿用已有记录
        const same = row<any>(
          this.db.prepare("SELECT * FROM evidence_records WHERE item_id = ? AND content_hash = ? ORDER BY collected_at ASC LIMIT 1"),
          existing.id,
          hash,
        );
        if (same) {
          this.db
            .prepare(
              `INSERT INTO custody_events (id, record_id, item_id, event_type, actor_id, detail, created_at)
               VALUES (?, ?, ?, 'resent_dedup', ?, ?, ?)`,
            )
            .run(newId(), same.id, existing.id, actor.id, JSON.stringify({ reused_record_id: same.id, batch: this.batchOf(input) }), at);
          return { outcome: "dedup" as const, itemId: existing.id, recordId: same.id };
        }
        // 同一标识出现异文：
        //  - 常规接入 → 新版本入库但隔离，等待核查
        //  - 冻结后明示的更正 / 补件（asLinkedFact）→ 作为关联事实版本留存，
        //    不改变材料当前状态，冻结版本仍不可变
        const recordId = this.insertRecord(existing.id, input, content, hash, actor.id, at);
        if (!opts.asLinkedFact) {
          this.db.prepare("UPDATE evidence_items SET status = 'quarantined' WHERE id = ?").run(existing.id);
        }
        this.db
          .prepare(
            `INSERT INTO custody_events (id, record_id, item_id, event_type, actor_id, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            recordId,
            existing.id,
            opts.asLinkedFact ? "linked_fact" : "variant_quarantined",
            actor.id,
            JSON.stringify({ new_record_id: recordId, content_hash: hash, expected_current: existing.current_record_id }),
            at,
          );
        return { outcome: (opts.asLinkedFact ? "ingested" : "quarantined") as "ingested" | "quarantined", itemId: existing.id, recordId };
      }

      // 全新标识（allowNewAfterFreeze 时允许冻结后以补件方式新增）
      const itemId = newId();
      this.db
        .prepare(
          `INSERT INTO evidence_items (id, case_id, source_key, source_native_id, title, status, current_record_id, in_frozen_manifest, first_collected_at)
           VALUES (?, ?, ?, ?, ?, 'admitted', ?, 0, ?)`,
        )
        .run(itemId, caseId, input.source_key, input.source_native_id, input.title ?? "", null, at);
      const recordId = this.insertRecord(itemId, input, content, hash, actor.id, at);
      this.db.prepare("UPDATE evidence_items SET current_record_id = ? WHERE id = ?").run(recordId, itemId);
      this.db
        .prepare(
          `INSERT INTO custody_events (id, record_id, item_id, event_type, actor_id, detail, created_at)
           VALUES (?, ?, ?, 'ingested', ?, ?, ?)`,
        )
        .run(newId(), recordId, itemId, actor.id, JSON.stringify({ source_summary: input.source_summary }), at);
      return { outcome: "ingested" as const, itemId, recordId };
    })();

    this.log(actor, `evidence.${result.outcome}`, "item", result.itemId, "success", {
      source_key: input.source_key,
      source_native_id: input.source_native_id,
      record_id: result.recordId,
    });
    return result;
  }

  private batchOf(input: IngestInput): unknown {
    const summary = input.source_summary as { batch?: unknown } | null;
    return summary && typeof summary === "object" ? summary.batch ?? null : null;
  }

  private insertRecord(
    itemId: string,
    input: IngestInput,
    content: Buffer,
    hash: string,
    actorId: string,
    at: string,
  ): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO evidence_records (id, item_id, content, media_type, source_summary, content_hash, collected_by, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, itemId, content, input.media_type ?? "application/json", stableStringify(input.source_summary ?? {}), hash, actorId, at);
    return id;
  }

  /** 业务复核人核查隔离异文：采信指定版本（或驳回，材料继续排除）。 */
  resolveQuarantine(actor: Actor, itemId: string, decision: "admit" | "reject", recordId?: string) {
    this.requireRole(actor, "reviewer", "admin");
    const item = this.getCaseOrThrow404(
      row<any>(this.db.prepare("SELECT * FROM evidence_items WHERE id = ?"), itemId),
      "item",
    );
    if (item.status !== "quarantined") throw Errors.validation("该材料不处于隔离状态");
    const at = this.now();
    let chosen = recordId;
    if (decision === "admit") {
      if (!chosen) throw Errors.validation("采信异文必须指定 record_id");
      const target = row<any>(this.db.prepare("SELECT * FROM evidence_records WHERE id = ? AND item_id = ?"), chosen, itemId);
      if (!target) throw Errors.notFound("record");
      this.db.prepare("UPDATE evidence_items SET status = 'admitted', current_record_id = ? WHERE id = ?").run(chosen, itemId);
    }
    this.db
      .prepare(
        `INSERT INTO custody_events (id, record_id, item_id, event_type, actor_id, detail, created_at)
         VALUES (?, ?, ?, 'quarantine_resolved', ?, ?, ?)`,
      )
      .run(newId(), chosen ?? null, itemId, actor.id, JSON.stringify({ decision }), at);
    this.log(actor, "quarantine.resolve", "item", itemId, "success", { decision, record_id: chosen ?? null });
    return { itemId, decision, recordId: chosen ?? null };
  }

  private getCaseOrThrow404<T>(value: T | undefined, resource: string): T {
    if (!value) throw Errors.notFound(resource);
    return value;
  }

  // ── 3. 冻结清单（不可变）+ 缺件说明 ──────────────────────────────────

  freezeManifest(actor: Actor, caseId: string) {
    this.requireRole(actor, "liaison");
    const caseRow = this.getCaseOrThrow(caseId);
    if (caseRow.status !== "open") throw Errors.manifestAlreadyFrozen();
    const scope = JSON.parse(caseRow.dispute_scope) as DisputeScope;
    const at = this.now();

    return this.db.transaction(() => {
      const admitted = rows<any>(
        this.db.prepare("SELECT * FROM evidence_items WHERE case_id = ? AND status = 'admitted' ORDER BY source_key, source_native_id"),
        caseId,
      );
      const scopeKey = (s: ScopeItem) => `${s.source_key}␟${s.source_native_id}`;
      const byKey = new Map(admitted.map((item) => [`${item.source_key}␟${item.source_native_id}`, item]));

      // 清单只冻结争议范围内的材料；范围之外已采集的材料不进清单
      const inScope = new Set(scope.expected.map(scopeKey));
      const scoped = admitted.filter((item) => inScope.has(`${item.source_key}␟${item.source_native_id}`));

      const missing: unknown[] = [];
      for (const expected of scope.expected) {
        const hit = byKey.get(scopeKey(expected));
        if (!hit) {
          // 已接入但隔离中的异文也要在缺件说明里点名
          const quarantined = row<any>(
            this.db.prepare(
              "SELECT * FROM evidence_items WHERE case_id = ? AND source_key = ? AND source_native_id = ? AND status = 'quarantined'",
            ),
            caseId,
            expected.source_key,
            expected.source_native_id,
          );
          missing.push({
            ...expected,
            reason: quarantined ? "quarantined_pending" : "not_collected",
          });
        }
      }

      const manifestId = newId();
      const entries = scoped.map((item) => ({
        id: newId(),
        item_id: item.id,
        record_id: item.current_record_id as string,
      }));
      const entryHashes = entries.map((entry) => {
        const record = row<any>(this.db.prepare("SELECT content_hash FROM evidence_records WHERE id = ?"), entry.record_id)!;
        return {
          item_id: entry.item_id,
          record_id: entry.record_id,
          record_hash: record.content_hash,
        };
      });
      const manifestHash = stableHash({
        case_id: caseId,
        scope: scope,
        entries: entryHashes
          .map((e) => ({ item_id: e.item_id, record_id: e.record_id, record_hash: e.record_hash }))
          .sort((a, b) => a.item_id.localeCompare(b.item_id)),
      });

      this.db
        .prepare(
          `INSERT INTO frozen_manifests (id, case_id, scope_snapshot, manifest_hash, missing_items, frozen_by, frozen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(manifestId, caseId, stableStringify(scope), manifestHash, stableStringify(missing), actor.id, at);

      const insertEntry = this.db.prepare(
        "INSERT INTO manifest_entries (id, manifest_id, item_id, record_id, record_hash) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [index, entry] of entries.entries()) {
        insertEntry.run(entry.id, manifestId, entry.item_id, entry.record_id, entryHashes[index].record_hash);
        this.db.prepare("UPDATE evidence_items SET in_frozen_manifest = 1 WHERE id = ?").run(entry.item_id);
      }
      this.db.prepare("UPDATE cases SET status = 'frozen', updated_at = ? WHERE id = ?").run(at, caseId);
      this.log(actor, "manifest.freeze", "manifest", manifestId, "success", {
        entries: entries.length,
        missing: missing.length,
        manifest_hash: manifestHash,
      });
      return {
        manifestId,
        manifest_hash: manifestHash,
        entry_count: entries.length,
        missing_items: missing,
        frozen_at: at,
      };
    })();
  }

  // ── 4. 冻结后追加关联事实（更正 / 撤回 / 补件）────────────────────────

  appendLinkedFact(
    actor: Actor,
    caseId: string,
    input: {
      kind: "correction" | "withdrawal" | "supplement";
      note?: string;
      relates_to_item_id?: string;
      evidence?: IngestInput;
    },
  ) {
    this.requireRole(actor, "liaison");
    const caseRow = this.getCaseOrThrow(caseId);
    if (caseRow.status === "open") throw Errors.validation("案件清单尚未冻结，无需追加关联事实");
    if (!input.kind) throw Errors.linkedFactKindRequired();
    if (input.relates_to_item_id) {
      this.getCaseOrThrow404(
        row(this.db.prepare("SELECT id FROM evidence_items WHERE id = ? AND case_id = ?"), input.relates_to_item_id, caseId),
        "item",
      );
    }

    const at = this.now();
    return this.db.transaction(() => {
      let recordId: string;
      if (input.evidence) {
        const ingestResult = this.ingest(actor, caseId, { ...input.evidence, title: input.evidence.title ?? "" }, {
          allowNewAfterFreeze: true,
          asLinkedFact: true,
        });
        recordId = ingestResult.recordId;
      } else {
        if (input.kind !== "withdrawal") throw Errors.validation("更正 / 补件必须附带新材料");
        // 撤回声明本身作为一条不可变记录保存
        const placeholder: IngestInput = {
          source_key: "withdrawal-notice",
          source_native_id: newId(),
          content: input.note ?? "",
          media_type: "text/plain",
          source_summary: { kind: "withdrawal", relates_to: input.relates_to_item_id ?? null, at },
        };
        recordId = this.ingest(actor, caseId, placeholder, {
          allowNewAfterFreeze: true,
          asLinkedFact: true,
        }).recordId;
      }

      const id = newId();
      this.db
        .prepare(
          `INSERT INTO linked_facts (id, case_id, record_id, relates_to_item_id, kind, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, caseId, recordId, input.relates_to_item_id ?? null, input.kind, input.note ?? "", actor.id, at);
      this.db
        .prepare(
          `INSERT INTO custody_events (id, record_id, item_id, event_type, actor_id, detail, created_at)
           VALUES (?, ?, ?, 'linked_fact', ?, ?, ?)`,
        )
        .run(
          newId(),
          recordId,
          input.relates_to_item_id ?? row<any>(this.db.prepare("SELECT item_id FROM evidence_records WHERE id = ?"), recordId)!.item_id,
          actor.id,
          JSON.stringify({ kind: input.kind, linked_fact_id: id }),
          at,
        );
      this.log(actor, "fact.append", "linked_fact", id, "success", { kind: input.kind, record_id: recordId });
      return { id, kind: input.kind, record_id: recordId };
    })();
  }

  // ── 5. 业务复核（意见持久化，未完成意见也不丢）────────────────────────

  private currentManifest(caseId: string) {
    const manifest = row<any>(this.db.prepare("SELECT * FROM frozen_manifests WHERE case_id = ?"), caseId);
    if (!manifest) throw Errors.caseNotFrozen();
    return manifest;
  }

  submitReview(actor: Actor, caseId: string, input: { decision: "complete" | "incomplete"; note?: string }) {
    this.requireRole(actor, "reviewer");
    const manifest = this.currentManifest(caseId);
    this.assertNotSubmitter(actor, manifest.id);
    const id = newId();
    const at = this.now();
    this.db
      .prepare(
        "INSERT INTO reviews (id, case_id, manifest_id, decision, note, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, caseId, manifest.id, input.decision, input.note ?? "", actor.id, at);
    this.log(actor, "review.submit", "review", id, "success", { decision: input.decision });
    return { id, decision: input.decision, note: input.note ?? "", reviewer_id: actor.id, created_at: at };
  }

  // ── 6. 隐私专员基于同一冻结版本批准字段遮盖 ───────────────────────────

  approveRedaction(actor: Actor, caseId: string, rules: RedactionRule[]) {
    this.requireRole(actor, "privacy_officer");
    if (!Array.isArray(rules)) throw Errors.validation("rules 必须为数组");
    const manifest = this.currentManifest(caseId);
    this.assertNotSubmitter(actor, manifest.id);
    const id = newId();
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE redactions SET status = 'superseded' WHERE case_id = ? AND status = 'approved'").run(caseId);
      this.db
        .prepare(
          "INSERT INTO redactions (id, case_id, manifest_id, rules, status, approved_by, approved_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)",
        )
        .run(id, caseId, manifest.id, stableStringify(rules), actor.id, at);
    })();
    this.log(actor, "redaction.approve", "redaction", id, "success", { manifest_id: manifest.id, rules: rules.length });
    return { id, manifest_id: manifest.id, rules, approved_by: actor.id, approved_at: at };
  }

  // ── 7. 放行交付包：稳定摘要 + 缺件说明 + 放行人 ───────────────────────

  releasePackage(actor: Actor, caseId: string) {
    this.requireRole(actor, "releaser");
    const caseRow = this.getCaseOrThrow(caseId);
    if (caseRow.status !== "frozen" && caseRow.status !== "delivered") throw Errors.caseNotFrozen();
    const manifest = this.currentManifest(caseId);
    this.assertNotSubmitter(actor, manifest.id);

    const latestReview = row<any>(
      this.db.prepare("SELECT * FROM reviews WHERE manifest_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
      manifest.id,
    );
    if (!latestReview) throw Errors.validation("尚未进行业务复核");
    if (latestReview.decision !== "complete") throw Errors.reviewIncomplete();

    const redaction = row<any>(
      this.db.prepare("SELECT * FROM redactions WHERE case_id = ? AND status = 'approved' ORDER BY approved_at DESC LIMIT 1"),
      caseId,
    );
    if (!redaction) throw Errors.redactionMissing();
    if (redaction.manifest_id !== manifest.id) throw Errors.redactionVersionMismatch();

    const at = this.now();
    return this.db.transaction(() => {
      const rules = parseJsonArray(redaction.rules) as RedactionRule[];
      const entries = rows<any>(this.db.prepare("SELECT * FROM manifest_entries WHERE manifest_id = ? ORDER BY item_id"), manifest.id);

      const packageId = newId();
      const packageEntries: unknown[] = [];
      const entryRows: Array<{ entry: any; bytes: Buffer; changed: string[]; deliveredHash: string }> = [];
      for (const entry of entries) {
        const record = row<any>(this.db.prepare("SELECT * FROM evidence_records WHERE id = ?"), entry.record_id)!;
        const { bytes, changed } = applyRedaction(record, rules);
        const deliveredHash = sha256(bytes);
        entryRows.push({ entry, bytes, changed, deliveredHash });
        packageEntries.push({
          item_id: entry.item_id,
          source_record_id: entry.record_id,
          source_record_hash: entry.record_hash,
          delivered_hash: deliveredHash,
          changed_fields: changed,
        });
      }

      // 冻结后追加的更正 / 撤回 / 补件随包交付，但绝不改动冻结清单
      const facts = rows<any>(this.db.prepare("SELECT * FROM linked_facts WHERE case_id = ? ORDER BY created_at, id"), caseId);
      const factRows: Array<{ fact: any; bytes: Buffer; changed: string[]; deliveredHash: string }> = [];
      const packageFacts: unknown[] = [];
      for (const fact of facts) {
        const record = row<any>(this.db.prepare("SELECT * FROM evidence_records WHERE id = ?"), fact.record_id)!;
        const { bytes, changed } = applyRedaction(record, rules);
        const deliveredHash = sha256(bytes);
        factRows.push({ fact, bytes, changed, deliveredHash });
        packageFacts.push({
          linked_fact_id: fact.id,
          kind: fact.kind,
          relates_to_item_id: fact.relates_to_item_id,
          record_id: fact.record_id,
          source_record_hash: record.content_hash,
          delivered_hash: deliveredHash,
          changed_fields: changed,
        });
      }

      const missingItems = parseJsonArray(manifest.missing_items);
      const packageHash = stableHash({
        case_id: caseId,
        manifest_id: manifest.id,
        manifest_hash: manifest.manifest_hash,
        redaction_id: redaction.id,
        redaction_rules: rules,
        entries: packageEntries,
        linked_facts: packageFacts,
        missing_items: missingItems,
      });

      this.db
        .prepare(
          `INSERT INTO packages (id, case_id, manifest_id, redaction_id, package_hash, missing_items, released_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(packageId, caseId, manifest.id, redaction.id, packageHash, manifest.missing_items, actor.id, at);

      const insertEntry = this.db.prepare(
        `INSERT INTO package_entries (id, package_id, item_id, source_record_id, source_record_hash, delivered_hash, changed_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { entry, changed, deliveredHash } of entryRows) {
        insertEntry.run(newId(), packageId, entry.item_id, entry.record_id, entry.record_hash, deliveredHash, stableStringify(changed));
      }
      const insertFact = this.db.prepare(
        `INSERT INTO package_linked_facts
           (id, package_id, linked_fact_id, record_id, kind, relates_to_item_id, note, source_record_hash, delivered_hash, changed_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { fact, changed, deliveredHash } of factRows) {
        const record = row<any>(this.db.prepare("SELECT content_hash FROM evidence_records WHERE id = ?"), fact.record_id)!;
        insertFact.run(
          newId(),
          packageId,
          fact.id,
          fact.record_id,
          fact.kind,
          fact.relates_to_item_id,
          fact.note,
          record.content_hash,
          deliveredHash,
          stableStringify(changed),
        );
      }

      this.db.prepare("UPDATE cases SET status = 'delivered', updated_at = ? WHERE id = ?").run(at, caseId);
      this.log(actor, "package.release", "package", packageId, "success", {
        manifest_hash: manifest.manifest_hash,
        package_hash: packageHash,
        entries: packageEntries.length,
        linked_facts: packageFacts.length,
      });
      return {
        package_id: packageId,
        package_hash: packageHash,
        manifest_hash: manifest.manifest_hash,
        missing_items: missingItems,
        entry_count: packageEntries.length,
        linked_fact_count: packageFacts.length,
        released_by: actor.id,
        created_at: at,
      };
    })();
  }

  // ── 8. 限时下载授权：签发 / 收回（即时失效）/ 凭 token 下载 ──────────

  issueGrant(actor: Actor, packageId: string, ttlSeconds = 48 * 3600) {
    this.requireRole(actor, "releaser");
    this.getCaseOrThrow404(row(this.db.prepare("SELECT id FROM packages WHERE id = ?"), packageId), "package");
    const id = newId();
    const at = this.now();
    const expires = new Date(this.clock().getTime() + ttlSeconds * 1000).toISOString();
    const token = newDownloadToken();
    this.db
      .prepare(
        `INSERT INTO download_grants (id, package_id, token_hash, status, expires_at, created_by, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, packageId, sha256(token), expires, actor.id, at);
    this.log(actor, "grant.issue", "grant", id, "success", { package_id: packageId, expires_at: expires });
    return { grant_id: id, token, expires_at: expires };
  }

  revokeGrant(actor: Actor, grantId: string) {
    this.requireRole(actor, "releaser", "admin");
    const grant = this.getCaseOrThrow404(row<any>(this.db.prepare("SELECT * FROM download_grants WHERE id = ?"), grantId), "grant");
    const at = this.now();
    this.db
      .prepare("UPDATE download_grants SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?")
      .run(at, actor.id, grantId);
    this.log(actor, "grant.revoke", "grant", grantId, "success", { package_id: grant.package_id });
    return { grant_id: grantId, status: "revoked", revoked_at: at };
  }

  /** 凭 token 取包；每次尝试留痕，撤销 / 过期 / 无效一律拒绝。 */
  downloadByToken(actorId: string, token: string) {
    const grant = row<any>(
      this.db.prepare("SELECT * FROM download_grants WHERE token_hash = ?"),
      sha256(token),
    );
    if (!grant) {
      this.log(actorId, "package.download", "grant", "", "denied", { reason: "invalid_token" });
      throw Errors.grantInvalid();
    }
    if (grant.status === "revoked") {
      this.log(actorId, "package.download", "grant", grant.id, "denied", { reason: "revoked" });
      throw Errors.grantRevoked();
    }
    if (Date.parse(grant.expires_at) <= this.clock().getTime()) {
      this.log(actorId, "package.download", "grant", grant.id, "denied", { reason: "expired" });
      throw Errors.grantExpired();
    }

    const pkg = row<any>(this.db.prepare("SELECT * FROM packages WHERE id = ?"), grant.package_id)!;
    const manifest = row<any>(this.db.prepare("SELECT * FROM frozen_manifests WHERE id = ?"), pkg.manifest_id)!;
    const redaction = row<any>(this.db.prepare("SELECT * FROM redactions WHERE id = ?"), pkg.redaction_id)!;
    const rules = parseJsonArray(redaction.rules) as RedactionRule[];
    const entries = rows<any>(
      this.db.prepare("SELECT * FROM package_entries WHERE package_id = ? ORDER BY item_id"),
      pkg.id,
    );
    const items = entries.map((entry) => {
      const record = row<any>(this.db.prepare("SELECT * FROM evidence_records WHERE id = ?"), entry.source_record_id)!;
      const item = row<any>(this.db.prepare("SELECT * FROM evidence_items WHERE id = ?"), entry.item_id)!;
      const { bytes } = applyRedaction(record, rules);
      // 复算结果必须与放行时固化的交付摘要一致，否则说明遮盖版本与包不一致
      if (sha256(bytes) !== entry.delivered_hash) {
        this.log(actorId, "package.download", "package", pkg.id, "error", { reason: "delivered_hash_mismatch", item_id: entry.item_id });
        throw new DomainError("PACKAGE_INTEGRITY_FAILED", "交付内容与放行摘要不一致，已拒绝下载");
      }
      return {
        item_id: entry.item_id,
        source_key: item.source_key,
        source_native_id: item.source_native_id,
        source_record_hash: entry.source_record_hash,
        delivered_hash: entry.delivered_hash,
        changed_fields: parseJsonArray(entry.changed_fields),
        content_base64: bytes.toString("base64"),
      };
    });

    const factEntries = rows<any>(
      this.db.prepare("SELECT * FROM package_linked_facts WHERE package_id = ? ORDER BY id"),
      pkg.id,
    );
    const linkedFacts = factEntries.map((fact) => {
      const record = row<any>(this.db.prepare("SELECT * FROM evidence_records WHERE id = ?"), fact.record_id)!;
      const { bytes } = applyRedaction(record, rules);
      if (sha256(bytes) !== fact.delivered_hash) {
        this.log(actorId, "package.download", "package", pkg.id, "error", { reason: "delivered_hash_mismatch", linked_fact_id: fact.id });
        throw new DomainError("PACKAGE_INTEGRITY_FAILED", "关联事实与放行摘要不一致，已拒绝下载");
      }
      return {
        linked_fact_id: fact.linked_fact_id,
        kind: fact.kind,
        relates_to_item_id: fact.relates_to_item_id,
        note: fact.note,
        source_record_hash: fact.source_record_hash,
        delivered_hash: fact.delivered_hash,
        changed_fields: parseJsonArray(fact.changed_fields),
        content_base64: bytes.toString("base64"),
      };
    });

    this.log(actorId, "package.download", "package", pkg.id, "success", { grant_id: grant.id });
    return {
      package_id: pkg.id,
      case_id: pkg.case_id,
      package_hash: pkg.package_hash,
      manifest_hash: manifest.manifest_hash,
      missing_items: parseJsonArray(pkg.missing_items),
      released_by: pkg.released_by,
      entries: items,
      linked_facts: linkedFacts,
    };
  }

  // ── 9. 法律保全与常规清理 ─────────────────────────────────────────────

  placeLegalHold(actor: Actor, caseId: string, reason: string) {
    this.requireRole(actor, "admin");
    this.getCaseOrThrow(caseId);
    if (!reason?.trim()) throw Errors.validation("法律保全必须说明理由");
    const id = newId();
    const at = this.now();
    this.db
      .prepare("INSERT INTO legal_holds (id, case_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, caseId, reason, actor.id, at);
    this.log(actor, "hold.place", "legal_hold", id, "success", { case_id: caseId, reason });
    return { id, case_id: caseId, reason, created_at: at };
  }

  releaseLegalHold(actor: Actor, holdId: string) {
    this.requireRole(actor, "admin");
    const hold = this.getCaseOrThrow404(row<any>(this.db.prepare("SELECT * FROM legal_holds WHERE id = ?"), holdId), "legal_hold");
    const at = this.now();
    this.db.prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?").run(at, actor.id, holdId);
    this.log(actor, "hold.release", "legal_hold", holdId, "success", { case_id: hold.case_id });
    return { id: holdId, released_at: at };
  }

  /** 常规清理：删除过保留期案件；法律保全生效中的一律跳过并记录。 */
  runCleanup(actor: Actor) {
    this.requireRole(actor, "admin");
    const at = this.now();
    const nowMs = this.clock().getTime();
    const result = this.db.transaction(() => {
      const candidates = rows<any>(
        this.db.prepare("SELECT * FROM cases WHERE retention_until IS NOT NULL AND retention_until < ?"),
        new Date(nowMs).toISOString(),
      );
      const deleted: string[] = [];
      const skippedHolds: string[] = [];
      for (const candidate of candidates) {
        const holds = row<{ n: number }>(
          this.db.prepare("SELECT COUNT(*) AS n FROM legal_holds WHERE case_id = ? AND released_at IS NULL"),
          candidate.id,
        );
        if ((holds?.n ?? 0) > 0) {
          skippedHolds.push(candidate.id);
          continue;
        }
        this.db.prepare("DELETE FROM cases WHERE id = ?").run(candidate.id);
        deleted.push(candidate.id);
      }
      const runId = newId();
      const detail = { deleted, skipped_holds: skippedHolds };
      this.db
        .prepare("INSERT INTO cleanup_runs (id, detail, actor_id, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, JSON.stringify(detail), actor.id, at);
      this.log(actor, "cleanup.run", "cleanup", runId, "success", detail);
      return detail;
    })();
    return result;
  }

  // ── 10. 事后抽查审计 ──────────────────────────────────────────────────

  /** 抽查一个交付包：原始版本、遮盖变化、实际放行人、授权与访问痕迹全在其中。 */
  auditPackage(actor: Actor, packageId: string) {
    const pkg = this.getCaseOrThrow404(row<any>(this.db.prepare("SELECT * FROM packages WHERE id = ?"), packageId), "package");
    this.log(actor, "package.audit", "package", packageId, "success", { case_id: pkg.case_id });
    const manifest = row<any>(this.db.prepare("SELECT * FROM frozen_manifests WHERE id = ?"), pkg.manifest_id)!;
    const review = row<any>(
      this.db.prepare("SELECT * FROM reviews WHERE manifest_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
      manifest.id,
    );
    const redaction = row<any>(this.db.prepare("SELECT * FROM redactions WHERE id = ?"), pkg.redaction_id)!;
    const entries = rows<any>(this.db.prepare("SELECT * FROM package_entries WHERE package_id = ? ORDER BY item_id"), packageId).map(
      (entry) => ({
        ...entry,
        changed_fields: parseJsonArray(entry.changed_fields),
        original_record: row<any>(this.db.prepare("SELECT id, content_hash, collected_by, collected_at, source_summary FROM evidence_records WHERE id = ?"), entry.source_record_id),
      }),
    );
    const grants = rows<any>(this.db.prepare("SELECT id, status, expires_at, created_by, created_at, revoked_at, revoked_by FROM download_grants WHERE package_id = ? ORDER BY created_at"), packageId);
    const linkedFacts = rows<any>(
      this.db.prepare("SELECT * FROM package_linked_facts WHERE package_id = ? ORDER BY id"),
      packageId,
    ).map((fact) => ({ ...fact, changed_fields: parseJsonArray(fact.changed_fields) }));

    const grantIds = grants.map((g) => g.id);
    const placeholders = grantIds.map(() => "?").join(",");
    const accessLogs = grantIds.length
      ? rows<any>(
          this.db.prepare(
            `SELECT * FROM access_logs
             WHERE (resource_type IN ('package', 'manifest') AND resource_id IN (?, ?))
                OR (resource_type = 'grant' AND resource_id IN (${placeholders}))
             ORDER BY created_at`,
          ),
          packageId,
          manifest.id,
          ...grantIds,
        )
      : rows<any>(
          this.db.prepare(
            "SELECT * FROM access_logs WHERE resource_type IN ('package', 'manifest') AND resource_id IN (?, ?) ORDER BY created_at",
          ),
          packageId,
          manifest.id,
        );
    return {
      package: { ...pkg, missing_items: parseJsonArray(pkg.missing_items) },
      manifest: { id: manifest.id, manifest_hash: manifest.manifest_hash, frozen_by: manifest.frozen_by, frozen_at: manifest.frozen_at },
      review: review ? { decision: review.decision, reviewer_id: review.reviewer_id, note: review.note, created_at: review.created_at } : null,
      redaction: { id: redaction.id, rules: parseJsonArray(redaction.rules), approved_by: redaction.approved_by, approved_at: redaction.approved_at },
      entries,
      linked_facts: linkedFacts,
      grants,
      access_logs: accessLogs,
    };
  }

  listAccessLogs(actor: Actor, caseId: string) {
    this.requireRole(actor, "reviewer", "admin", "releaser");
    this.getCaseOrThrow(caseId);
    return rows<any>(
      this.db.prepare(
        `SELECT * FROM access_logs
         WHERE (resource_type = 'case' AND resource_id = ?)
            OR resource_id IN (SELECT id FROM frozen_manifests WHERE case_id = ?)
            OR resource_id IN (SELECT id FROM packages WHERE case_id = ?)
            OR resource_id IN (SELECT id FROM download_grants WHERE package_id IN (SELECT id FROM packages WHERE case_id = ?))
            OR detail LIKE ?
         ORDER BY created_at`,
      ),
      caseId,
      caseId,
      caseId,
      caseId,
      `%${caseId}%`,
    );
  }
}

// ── 遮盖应用：确定性，同一规则集 + 同一原文 ⇒ 同一交付字节 ──────────────

function applyRedaction(
  record: { content: Buffer; media_type: string },
  rules: RedactionRule[],
): { bytes: Buffer; changed: string[] } {
  const root: unknown =
    record.media_type === "application/json" ? JSON.parse(record.content.toString("utf8")) : { text: record.content.toString("utf8") };
  const changed: string[] = [];
  for (const rule of rules) {
    if (setMaskedPath(root, rule.field_path.split("."))) changed.push(rule.field_path);
  }
  return { bytes: Buffer.from(stableStringify(root), "utf8"), changed };
}

function setMaskedPath(target: unknown, path: string[]): boolean {
  if (path.length === 0 || target === null || typeof target !== "object") return false;
  const [head, ...rest] = path;
  const container = target as Record<string, unknown>;
  if (!(head in container)) return false;
  if (rest.length === 0) {
    if (container[head] === "【已遮盖】" || container[head] === undefined) return false;
    container[head] = "【已遮盖】";
    return true;
  }
  return setMaskedPath(container[head], rest);
}
