import type { EvidenceDatabase } from "../database.js";
import {
  DomainError,
  canonicalDigest,
  newId,
  nowIso,
  safeEqualHex,
  sha256,
} from "./util.js";

export type SourceType = "email_attachment" | "hotline_transcript" | "merchant_supplement";

export interface IngestInput {
  externalKey: string;
  sourceType: SourceType;
  content: Buffer;
  mediaType?: string | null;
  sourceSummary: string;
  collectedAt: string;
  receivedBatch?: string | null;
  submittedBy: string;
}

type IngestTransactionResult =
  | { quarantined: true; materialId: string; versionId: string; contentHash: string }
  | {
      quarantined: false;
      deduplicated: boolean;
      appendedFact?: string;
      materialId: string;
      versionId: string;
      status: string;
      contentHash: string;
    };

export interface RedactionInput {
  materialId: string;
  redactedContent: Buffer;
  changeSummary?: string;
}

export interface MissingItemInput {
  expectedRef: string;
  reason: string;
}

export class EvidenceService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // -- 辅助 -------------------------------------------------------------

  private now(): string {
    return nowIso(this.clock);
  }

  private async requireCase(trx: EvidenceDatabase, caseId: string) {
    const row = await trx
      .selectFrom("preservation_cases")
      .selectAll()
      .where("id", "=", caseId)
      .executeTakeFirst();
    if (!row) throw new DomainError("CASE_NOT_FOUND", "保全案件不存在", 404);
    return row;
  }

  private async log(
    trx: EvidenceDatabase,
    action: string,
    actor: string,
    caseId: string | null,
    detail: Record<string, unknown> = {},
  ) {
    await trx
      .insertInto("access_logs")
      .values({
        id: newId("log"),
        case_id: caseId,
        action,
        actor,
        detail: JSON.stringify(detail),
        created_at: this.now(),
      })
      .execute();
  }

  private async custody(
    trx: EvidenceDatabase,
    caseId: string,
    actor: string,
    eventType: string,
    detail: Record<string, unknown>,
    materialId: string | null = null,
    versionId: string | null = null,
  ) {
    await trx
      .insertInto("custody_events")
      .values({
        id: newId("cst"),
        case_id: caseId,
        material_id: materialId,
        version_id: versionId,
        event_type: eventType,
        detail: JSON.stringify(detail),
        actor,
        created_at: this.now(),
      })
      .execute();
  }

  // -- 案件与时限 -------------------------------------------------------

  async createCase(input: {
    disputeScope: unknown;
    createdBy: string;
    deadlineAt: string;
  }) {
    if (!input.createdBy) throw new DomainError("VALIDATION", "缺少建案人", 400);
    if (Number.isNaN(Date.parse(input.deadlineAt))) {
      throw new DomainError("VALIDATION", "deadline_at 不是合法时间", 400);
    }
    return this.db.transaction().execute(async (trx) => {
      const kase = await trx
        .insertInto("preservation_cases")
        .values({
          id: newId("case"),
          dispute_scope: JSON.stringify(input.disputeScope ?? {}),
          status: "open",
          created_by: input.createdBy,
          deadline_at: new Date(input.deadlineAt).toISOString(),
          legal_hold: 0,
          created_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.custody(trx, kase.id, input.createdBy, "CASE_OPENED", {
        deadline_at: kase.deadline_at,
      });
      await this.log(trx, "case.create", input.createdBy, kase.id);
      return kase;
    });
  }

  async getCase(caseId: string) {
    const kase = await this.db
      .selectFrom("preservation_cases")
      .selectAll()
      .where("id", "=", caseId)
      .executeTakeFirst();
    if (!kase) throw new DomainError("CASE_NOT_FOUND", "保全案件不存在", 404);
    return kase;
  }

  /** 法定期限续期：必须给出理由，且新期限晚于当前期限（绝对时钟不重置）。 */
  async extendDeadline(
    caseId: string,
    input: { newDeadlineAt: string; reason: string; requestedBy: string },
  ) {
    if (!input.reason?.trim()) {
      throw new DomainError("REASON_REQUIRED", "续期必须填写理由", 422);
    }
    if (Number.isNaN(Date.parse(input.newDeadlineAt))) {
      throw new DomainError("VALIDATION", "new_deadline_at 不是合法时间", 400);
    }
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      const next = new Date(input.newDeadlineAt).toISOString();
      if (Date.parse(next) <= Date.parse(kase.deadline_at)) {
        throw new DomainError(
          "DEADLINE_NOT_LATER",
          "续期后的时限必须晚于当前时限",
          422,
        );
      }
      await trx
        .insertInto("case_deadline_extensions")
        .values({
          id: newId("ext"),
          case_id: kase.id,
          new_deadline_at: next,
          reason: input.reason,
          requested_by: input.requestedBy,
          created_at: this.now(),
        })
        .execute();
      const updated = await trx
        .updateTable("preservation_cases")
        .set({ deadline_at: next })
        .where("id", "=", kase.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.custody(trx, kase.id, input.requestedBy, "DEADLINE_EXTENDED", {
        previous_deadline_at: kase.deadline_at,
        new_deadline_at: next,
        reason: input.reason,
      });
      await this.log(trx, "case.deadline.extend", input.requestedBy, kase.id, {
        new_deadline_at: next,
      });
      return updated;
    });
  }

  /** 法律保全生效：此后常规清理不得触碰本案。 */
  async imposeLegalHold(caseId: string, input: { reason: string; actor: string }) {
    if (!input.reason?.trim()) {
      throw new DomainError("REASON_REQUIRED", "法律保全必须填写理由", 422);
    }
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      if (kase.legal_hold) return kase;
      const updated = await trx
        .updateTable("preservation_cases")
        .set({
          legal_hold: 1,
          legal_hold_at: this.now(),
          legal_hold_reason: input.reason,
        })
        .where("id", "=", kase.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.custody(trx, kase.id, input.actor, "LEGAL_HOLD_IMPOSED", {
        reason: input.reason,
      });
      await this.log(trx, "case.legal_hold.impose", input.actor, kase.id);
      return updated;
    });
  }

  // -- 材料接入 ---------------------------------------------------------

  /**
   * 接入一份材料。
   * - 同内容重送：沿用已有版本记录，仅追加保管链；
   * - 同标识异文（冻结前）：隔离待核查；
   * - 冻结后到达：不改动清单，只追加为更正/补件关联事实。
   */
  async ingestMaterial(caseId: string, input: IngestInput) {
    if (!input.externalKey || !input.sourceSummary || !input.submittedBy) {
      throw new DomainError("VALIDATION", "缺少标识、来源摘要或提交人", 400);
    }
    if (!Buffer.isBuffer(input.content) || input.content.length === 0) {
      throw new DomainError("VALIDATION", "缺少材料内容", 400);
    }
    if (Number.isNaN(Date.parse(input.collectedAt))) {
      throw new DomainError("VALIDATION", "collected_at 不是合法时间", 400);
    }
    const contentHash = sha256(input.content);
    const collectedAt = new Date(input.collectedAt).toISOString();

    // 隔离事件必须先提交（事务内抛错会回滚隔离记录），因此用标记在事务外抛错。
    const result = await this.db.transaction().execute(
      async (trx): Promise<IngestTransactionResult> => {
      const kase = await this.requireCase(trx, caseId);
      let material = await trx
        .selectFrom("material_records")
        .selectAll()
        .where("case_id", "=", kase.id)
        .where("external_key", "=", input.externalKey)
        .executeTakeFirst();

      if (!material) {
        material = await trx
          .insertInto("material_records")
          .values({
            id: newId("mat"),
            case_id: kase.id,
            external_key: input.externalKey,
            source_type: input.sourceType,
            created_by: input.submittedBy,
            created_at: this.now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      const sameHash = await trx
        .selectFrom("material_versions")
        .selectAll()
        .where("material_id", "=", material.id)
        .where("content_hash", "=", contentHash)
        .executeTakeFirst();

      if (sameHash) {
        // 同内容重送：沿用已有记录。
        await this.custody(
          trx,
          kase.id,
          input.submittedBy,
          "REINGEST_DEDUP",
          {
            external_key: input.externalKey,
            received_batch: input.receivedBatch ?? null,
            reused_version_id: sameHash.id,
          },
          material.id,
          sameHash.id,
        );
        await this.log(trx, "material.ingest.dedup", input.submittedBy, kase.id, {
          material_id: material.id,
          version_id: sameHash.id,
        });
        return {
          quarantined: false,
          deduplicated: true,
          materialId: material.id,
          versionId: sameHash.id,
          status: sameHash.status,
          contentHash,
        };
      }

      if (kase.frozen_at) {
        // 冻结后：更正（标识已存在）或补件（新标识），只能追加关联事实。
        const priorVersions = await this.versionCount(trx, material.id);
        const factType = priorVersions > 0 ? "correction" : "supplement";
        const version = await trx
          .insertInto("material_versions")
          .values({
            id: newId("ver"),
            material_id: material.id,
            version_no: priorVersions + 1,
            content_hash: contentHash,
            content: input.content,
            media_type: input.mediaType ?? null,
            source_summary: input.sourceSummary,
            collected_at: collectedAt,
            received_batch: input.receivedBatch ?? null,
            submitted_by: input.submittedBy,
            status: "linked",
            created_at: this.now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const manifest = await this.requireManifestRow(trx, kase.id);
        await this.appendFact(trx, {
          caseId: kase.id,
          manifestId: manifest.id,
          factType,
          materialId: material.id,
          versionId: version.id,
          summary: input.sourceSummary,
          contentHash,
          content: input.content,
          submittedBy: input.submittedBy,
        });
        return {
          quarantined: false,
          deduplicated: false,
          appendedFact: factType,
          materialId: material.id,
          versionId: version.id,
          status: "linked",
          contentHash,
        };
      }

      const priorCount = await this.versionCount(trx, material.id);
      const status = priorCount === 0 ? "current" : "quarantined";
      const version = await trx
        .insertInto("material_versions")
        .values({
          id: newId("ver"),
          material_id: material.id,
          version_no: priorCount + 1,
          content_hash: contentHash,
          content: input.content,
          media_type: input.mediaType ?? null,
          source_summary: input.sourceSummary,
          collected_at: collectedAt,
          received_batch: input.receivedBatch ?? null,
          submitted_by: input.submittedBy,
          status,
          created_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.custody(
        trx,
        kase.id,
        input.submittedBy,
        status === "current" ? "MATERIAL_RECEIVED" : "VARIANT_QUARANTINED",
        {
          external_key: input.externalKey,
          source_type: input.sourceType,
          collected_at: collectedAt,
          received_batch: input.receivedBatch ?? null,
          content_hash: contentHash,
        },
        material.id,
        version.id,
      );
      await this.log(
        trx,
        status === "current" ? "material.ingest" : "material.quarantine",
        input.submittedBy,
        kase.id,
        { material_id: material.id, version_id: version.id },
      );

      if (status === "quarantined") {
        return {
          quarantined: true,
          materialId: material.id,
          versionId: version.id,
          contentHash,
        };
      }
      return {
        quarantined: false,
        deduplicated: false,
        materialId: material.id,
        versionId: version.id,
        status,
        contentHash,
      };
    });

    if (result.quarantined) {
      throw new DomainError(
        "QUARANTINED_VARIANT",
        `标识 ${input.externalKey} 出现异文，已隔离待核查`,
        422,
        { materialId: result.materialId, versionId: result.versionId, contentHash: result.contentHash },
      );
    }
    return result;
  }

  private async versionCount(trx: EvidenceDatabase, materialId: string): Promise<number> {
    const row = await trx
      .selectFrom("material_versions")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("material_id", "=", materialId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** 核查隔离中的异文：采纳则替换当前版本，驳回则记录为 rejected。 */
  async resolveQuarantine(
    versionId: string,
    input: { decision: "accept" | "reject"; actor: string },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const version = await trx
        .selectFrom("material_versions")
        .selectAll()
        .where("id", "=", versionId)
        .executeTakeFirst();
      if (!version || version.status !== "quarantined") {
        throw new DomainError("MATERIAL_NOT_FOUND", "待核查的异文版本不存在", 404);
      }
      const material = await trx
        .selectFrom("material_records")
        .selectAll()
        .where("id", "=", version.material_id)
        .executeTakeFirstOrThrow();
      const kase = await this.requireCase(trx, material.case_id);
      if (kase.frozen_at) {
        throw new DomainError("ALREADY_FROZEN", "清单冻结后异文只能作为关联事实处理", 409);
      }

      if (input.decision === "accept") {
        await trx
          .updateTable("material_versions")
          .set({ status: "superseded" })
          .where("material_id", "=", material.id)
          .where("status", "=", "current")
          .execute();
        await trx
          .updateTable("material_versions")
          .set({ status: "current" })
          .where("id", "=", version.id)
          .execute();
      } else {
        await trx
          .updateTable("material_versions")
          .set({ status: "rejected" })
          .where("id", "=", version.id)
          .execute();
      }
      await this.custody(
        trx,
        kase.id,
        input.actor,
        input.decision === "accept" ? "QUARANTINE_ACCEPTED" : "QUARANTINE_REJECTED",
        { version_id: version.id },
        material.id,
        version.id,
      );
      await this.log(trx, "material.quarantine.resolve", input.actor, kase.id, {
        material_id: material.id,
        version_id: version.id,
        decision: input.decision,
      });
      return { versionId: version.id, decision: input.decision };
    });
  }

  /** 冻结后撤回：清单条目保留，只追加撤回事实。 */
  async recordWithdrawal(
    caseId: string,
    input: { externalKey: string; summary: string; submittedBy: string },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      if (!kase.frozen_at) throw new DomainError("NOT_FROZEN", "清单尚未冻结", 422);
      const material = await trx
        .selectFrom("material_records")
        .selectAll()
        .where("case_id", "=", kase.id)
        .where("external_key", "=", input.externalKey)
        .executeTakeFirst();
      if (!material) {
        throw new DomainError("MATERIAL_NOT_FOUND", "材料标识不存在", 404);
      }
      const manifest = await this.requireManifestRow(trx, kase.id);
      await this.appendFact(trx, {
        caseId: kase.id,
        manifestId: manifest.id,
        factType: "withdrawal",
        materialId: material.id,
        versionId: null,
        summary: input.summary,
        contentHash: null,
        content: null,
        submittedBy: input.submittedBy,
      });
      return { materialId: material.id, factType: "withdrawal" as const };
    });
  }

  private async appendFact(
    trx: EvidenceDatabase,
    fields: {
      caseId: string;
      manifestId: string;
      factType: "correction" | "withdrawal" | "supplement";
      materialId: string | null;
      versionId: string | null;
      summary: string;
      contentHash: string | null;
      content: Buffer | null;
      submittedBy: string;
    },
  ) {
    const fact = await trx
      .insertInto("post_freeze_facts")
      .values({
        id: newId("fact"),
        case_id: fields.caseId,
        manifest_id: fields.manifestId,
        fact_type: fields.factType,
        material_id: fields.materialId,
        version_id: fields.versionId,
        external_ref: null,
        summary: fields.summary,
        content_hash: fields.contentHash,
        content: fields.content,
        submitted_by: fields.submittedBy,
        created_at: this.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.custody(
      trx,
      fields.caseId,
      fields.submittedBy,
      `POST_FREEZE_${fields.factType.toUpperCase()}`,
      { fact_id: fact.id, summary: fields.summary },
      fields.materialId,
      fields.versionId,
    );
    await this.log(
      trx,
      `fact.${fields.factType}.append`,
      fields.submittedBy,
      fields.caseId,
      { fact_id: fact.id },
    );
    // 新事实使尚未放行的包版本过时。
    await trx
      .updateTable("delivery_packages")
      .set({ status: "superseded" })
      .where("case_id", "=", fields.caseId)
      .where("status", "in", ["draft", "approved"])
      .execute();
    return fact;
  }

  // -- 冻结清单 ---------------------------------------------------------

  async freezeManifest(caseId: string, actor: string) {
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      if (kase.frozen_at) {
        throw new DomainError("ALREADY_FROZEN", "清单已冻结，冻结只有一次", 409);
      }

      const items = await trx
        .selectFrom("material_versions as v")
        .innerJoin("material_records as m", "m.id", "v.material_id")
        .select([
          "v.id as version_id",
          "v.version_no",
          "v.content_hash",
          "m.id as material_id",
          "m.external_key",
          "m.source_type",
        ])
        .where("m.case_id", "=", kase.id)
        .where("v.status", "=", "current")
        .orderBy("m.external_key")
        .execute();

      const digest = canonicalDigest({
        case_id: kase.id,
        items: items.map((i) => ({
          external_key: i.external_key,
          source_type: i.source_type,
          version_no: i.version_no,
          content_hash: i.content_hash,
        })),
      });

      const manifest = await trx
        .insertInto("manifests")
        .values({
          id: newId("mfst"),
          case_id: kase.id,
          digest,
          frozen_by: actor,
          frozen_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const item of items) {
        await trx
          .insertInto("manifest_items")
          .values({
            id: newId("mitm"),
            manifest_id: manifest.id,
            material_id: item.material_id,
            version_id: item.version_id,
          })
          .execute();
      }

      await trx
        .updateTable("preservation_cases")
        .set({ frozen_at: manifest.frozen_at })
        .where("id", "=", kase.id)
        .execute();

      await this.custody(trx, kase.id, actor, "MANIFEST_FROZEN", {
        manifest_id: manifest.id,
        item_count: items.length,
        digest,
      });
      await this.log(trx, "manifest.freeze", actor, kase.id, {
        manifest_id: manifest.id,
        item_count: items.length,
      });
      return { manifestId: manifest.id, digest, itemCount: items.length, items };
    });
  }

  private async requireManifestRow(trx: EvidenceDatabase, caseId: string) {
    const manifest = await trx
      .selectFrom("manifests")
      .selectAll()
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    if (!manifest) throw new DomainError("NOT_FROZEN", "清单尚未冻结", 422);
    return manifest;
  }

  async getManifest(caseId: string) {
    const kase = await this.getCase(caseId);
    const manifest = await this.db
      .selectFrom("manifests")
      .selectAll()
      .where("case_id", "=", kase.id)
      .executeTakeFirst();
    if (!manifest) throw new DomainError("MANIFEST_NOT_FOUND", "清单不存在", 404);
    const items = await this.db
      .selectFrom("manifest_items")
      .selectAll()
      .where("manifest_id", "=", manifest.id)
      .execute();
    return { ...manifest, items };
  }

  // -- 复核意见草稿（跨停服保留） ---------------------------------------

  async saveReviewDraft(
    caseId: string,
    input: { stage: "business" | "privacy"; author: string; body: string },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      const existing = await trx
        .selectFrom("review_drafts")
        .selectAll()
        .where("case_id", "=", kase.id)
        .where("stage", "=", input.stage)
        .where("author", "=", input.author)
        .executeTakeFirst();
      const ts = this.now();
      if (existing) {
        return trx
          .updateTable("review_drafts")
          .set({ body: input.body, updated_at: ts })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return trx
        .insertInto("review_drafts")
        .values({
          id: newId("drft"),
          case_id: kase.id,
          stage: input.stage,
          author: input.author,
          body: input.body,
          created_at: ts,
          updated_at: ts,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async listReviewDrafts(caseId: string) {
    await this.getCase(caseId);
    return this.db
      .selectFrom("review_drafts")
      .selectAll()
      .where("case_id", "=", caseId)
      .orderBy("updated_at", "desc")
      .execute();
  }

  // -- 业务复核 ---------------------------------------------------------

  /** 业务复核人确认清单完整；不得审批含本人提交材料的清单；每案一次。 */
  async submitBusinessReview(
    caseId: string,
    input: { reviewer: string; comment?: string | null },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      const manifest = await this.requireManifestRow(trx, kase.id);
      const existing = await trx
        .selectFrom("manifest_business_reviews")
        .selectAll()
        .where("manifest_id", "=", manifest.id)
        .executeTakeFirst();
      if (existing) {
        throw new DomainError("ALREADY_REVIEWED", "清单已完成业务复核", 409);
      }
      await this.assertNoOwnSubmission(trx, manifest.id, input.reviewer);
      const review = await trx
        .insertInto("manifest_business_reviews")
        .values({
          id: newId("revw"),
          manifest_id: manifest.id,
          reviewer: input.reviewer,
          comment: input.comment ?? null,
          created_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.custody(trx, kase.id, input.reviewer, "BUSINESS_REVIEW_APPROVED", {
        manifest_id: manifest.id,
      });
      await this.log(trx, "manifest.review.business", input.reviewer, kase.id);
      return review;
    });
  }

  private async assertNoOwnSubmission(
    trx: EvidenceDatabase,
    manifestId: string,
    person: string,
  ) {
    const own = await trx
      .selectFrom("manifest_items as i")
      .innerJoin("material_versions as v", "v.id", "i.version_id")
      .select("i.id")
      .where("i.manifest_id", "=", manifestId)
      .where("v.submitted_by", "=", person)
      .limit(1)
      .executeTakeFirst();
    if (own) {
      throw new DomainError(
        "SELF_APPROVAL_FORBIDDEN",
        "任何人都不能审批自己提交的材料",
        403,
      );
    }
  }

  private async manifestSubmitters(
    trx: EvidenceDatabase,
    manifestId: string,
  ): Promise<Set<string>> {
    const rows = await trx
      .selectFrom("manifest_items as i")
      .innerJoin("material_versions as v", "v.id", "i.version_id")
      .select("v.submitted_by")
      .distinct()
      .where("i.manifest_id", "=", manifestId)
      .execute();
    return new Set(rows.map((r) => r.submitted_by));
  }

  // -- 交付包：遮盖方案 + 缺件说明 + 稳定摘要 ---------------------------

  async preparePackage(
    caseId: string,
    input: {
      preparedBy: string;
      redactions: RedactionInput[];
      missingItems: MissingItemInput[];
    },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const kase = await this.requireCase(trx, caseId);
      const manifest = await this.requireManifestRow(trx, kase.id);
      const businessReview = await trx
        .selectFrom("manifest_business_reviews")
        .selectAll()
        .where("manifest_id", "=", manifest.id)
        .executeTakeFirst();
      if (!businessReview) {
        throw new DomainError("BUSINESS_REVIEW_REQUIRED", "需先完成业务复核", 422);
      }

      const items = await this.manifestItemRows(trx, manifest.id);
      const byMaterial = new Map(items.map((i) => [i.material_id, i]));
      for (const r of input.redactions) {
        if (!byMaterial.has(r.materialId)) {
          throw new DomainError(
            "VALIDATION",
            "遮盖目标不在冻结清单内",
            400,
            { materialId: r.materialId },
          );
        }
        if (!Buffer.isBuffer(r.redactedContent) || r.redactedContent.length === 0) {
          throw new DomainError("VALIDATION", "缺少遮盖后内容", 400);
        }
      }

      const lastVersion = await trx
        .selectFrom("delivery_packages")
        .select((eb) => eb.fn.max<number | null>("version_no").as("max_no"))
        .where("case_id", "=", kase.id)
        .executeTakeFirstOrThrow();
      const versionNo = (lastVersion.max_no ?? 0) + 1;
      const pkg = await trx
        .insertInto("delivery_packages")
        .values({
          id: newId("pkg"),
          case_id: kase.id,
          manifest_id: manifest.id,
          version_no: versionNo,
          digest: "",
          status: "draft",
          prepared_by: input.preparedBy,
          created_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const r of input.redactions) {
        const item = byMaterial.get(r.materialId)!;
        await trx
          .insertInto("package_redactions")
          .values({
            id: newId("red"),
            package_id: pkg.id,
            material_id: r.materialId,
            version_id: item.version_id,
            redacted_hash: sha256(r.redactedContent),
            redacted_content: r.redactedContent,
            change_summary: r.changeSummary ?? "",
          })
          .execute();
      }
      for (const m of input.missingItems) {
        if (!m.expectedRef || !m.reason) {
          throw new DomainError("VALIDATION", "缺件说明需包含标识与原因", 400);
        }
        await trx
          .insertInto("package_missing_items")
          .values({
            id: newId("mis"),
            package_id: pkg.id,
            expected_ref: m.expectedRef,
            reason: m.reason,
          })
          .execute();
      }

      const digest = await this.computePackageDigest(trx, pkg.id);
      const finalized = await trx
        .updateTable("delivery_packages")
        .set({ digest })
        .where("id", "=", pkg.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.custody(trx, kase.id, input.preparedBy, "PACKAGE_PREPARED", {
        package_id: pkg.id,
        version_no: versionNo,
        redaction_count: input.redactions.length,
        missing_count: input.missingItems.length,
        digest,
      });
      await this.log(trx, "package.prepare", input.preparedBy, kase.id, {
        package_id: pkg.id,
        version_no: versionNo,
      });
      return finalized;
    });
  }

  private async manifestItemRows(trx: EvidenceDatabase, manifestId: string) {
    return trx
      .selectFrom("manifest_items")
      .selectAll()
      .where("manifest_id", "=", manifestId)
      .orderBy("material_id")
      .execute();
  }

  private async computePackageDigest(trx: EvidenceDatabase, packageId: string) {
    const pkg = await trx
      .selectFrom("delivery_packages")
      .selectAll()
      .where("id", "=", packageId)
      .executeTakeFirstOrThrow();
    const items = await this.manifestItemRows(trx, pkg.manifest_id);
    const redactions = await trx
      .selectFrom("package_redactions")
      .selectAll()
      .where("package_id", "=", packageId)
      .execute();
    const redactionByMaterial = new Map(redactions.map((r) => [r.material_id, r]));
    const facts = await trx
      .selectFrom("post_freeze_facts")
      .selectAll()
      .where("manifest_id", "=", pkg.manifest_id)
      .orderBy("created_at").orderBy("id")
      .execute();
    const missing = await trx
      .selectFrom("package_missing_items")
      .selectAll()
      .where("package_id", "=", packageId)
      .orderBy("expected_ref").orderBy("id")
      .execute();

    return canonicalDigest({
      manifest_digest: (
        await trx
          .selectFrom("manifests")
          .select("digest")
          .where("id", "=", pkg.manifest_id)
          .executeTakeFirstOrThrow()
      ).digest,
      items: items.map((i) => {
        const red = redactionByMaterial.get(i.material_id);
        return {
          material_id: i.material_id,
          version_id: i.version_id,
          redacted_hash: red ? red.redacted_hash : null,
        };
      }),
      facts: facts.map((f) => ({
        fact_type: f.fact_type,
        material_id: f.material_id,
        version_id: f.version_id,
        summary: f.summary,
        content_hash: f.content_hash,
      })),
      missing: missing.map((m) => ({ expected_ref: m.expected_ref, reason: m.reason })),
    });
  }

  // -- 隐私批准（同一版本）与放行 ---------------------------------------

  async approvePrivacy(packageId: string, input: { officer: string; comment?: string | null }) {
    return this.db.transaction().execute(async (trx) => {
      const pkg = await trx
        .selectFrom("delivery_packages")
        .selectAll()
        .where("id", "=", packageId)
        .executeTakeFirst();
      if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "交付包不存在", 404);
      if (pkg.status !== "draft") {
        throw new DomainError("APPROVAL_VERSION_MISMATCH", "该包版本已不是待批准版本", 422);
      }
      await this.assertNoOwnSubmission(trx, pkg.manifest_id, input.officer);
      const submitters = await this.manifestSubmitters(trx, pkg.manifest_id);
      const factRows = await trx
        .selectFrom("post_freeze_facts")
        .select("submitted_by")
        .distinct()
        .where("manifest_id", "=", pkg.manifest_id)
        .execute();
      const factSubmitters = new Set(factRows.map((f) => f.submitted_by));
      if (
        input.officer === pkg.prepared_by ||
        submitters.has(input.officer) ||
        factSubmitters.has(input.officer)
      ) {
        throw new DomainError(
          "SELF_APPROVAL_FORBIDDEN",
          "任何人都不能审批自己提交或制备的材料",
          403,
        );
      }

      const currentDigest = await this.computePackageDigest(trx, pkg.id);
      if (currentDigest !== pkg.digest) {
        throw new DomainError(
          "APPROVAL_VERSION_MISMATCH",
          "包内容相对制备时已变化，必须基于当前版本重新制备",
          422,
        );
      }

      const approval = await trx
        .insertInto("package_privacy_approvals")
        .values({
          id: newId("papp"),
          package_id: pkg.id,
          officer: input.officer,
          digest: currentDigest,
          comment: input.comment ?? null,
          created_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("delivery_packages")
        .set({ status: "approved" })
        .where("id", "=", pkg.id)
        .execute();
      await this.custody(trx, pkg.case_id, input.officer, "PRIVACY_APPROVED", {
        package_id: pkg.id,
        version_no: pkg.version_no,
        digest: currentDigest,
      });
      await this.log(trx, "package.approve.privacy", input.officer, pkg.case_id, {
        package_id: pkg.id,
      });
      return approval;
    });
  }

  /** 放行：业务复核 + 隐私批准（钉住同一摘要）+ 法定时限未过。 */
  async releasePackage(packageId: string, actor: string) {
    return this.db.transaction().execute(async (trx) => {
      const pkg = await trx
        .selectFrom("delivery_packages")
        .selectAll()
        .where("id", "=", packageId)
        .executeTakeFirst();
      if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "交付包不存在", 404);

      const kase = await this.requireCase(trx, pkg.case_id);

      // 放行是最后一道审批关口，放行人同样不能是材料/事实的提交人或包制备人。
      await this.assertNoOwnSubmission(trx, pkg.manifest_id, actor);
      const submitters = await this.manifestSubmitters(trx, pkg.manifest_id);
      const factRows = await trx
        .selectFrom("post_freeze_facts")
        .select("submitted_by")
        .distinct()
        .where("manifest_id", "=", pkg.manifest_id)
        .execute();
      const factSubmitters = new Set(factRows.map((f) => f.submitted_by));
      if (actor === pkg.prepared_by || submitters.has(actor) || factSubmitters.has(actor)) {
        throw new DomainError(
          "SELF_APPROVAL_FORBIDDEN",
          "任何人都不能放行自己提交或制备的材料",
          403,
        );
      }

      if (this.clock().getTime() > Date.parse(kase.deadline_at)) {
        throw new DomainError(
          "DEADLINE_PASSED",
          "法定时限已过，须先依法续期",
          422,
          { deadline_at: kase.deadline_at },
        );
      }

      const businessReview = await trx
        .selectFrom("manifest_business_reviews")
        .selectAll()
        .where("manifest_id", "=", pkg.manifest_id)
        .executeTakeFirst();
      if (!businessReview) {
        throw new DomainError("BUSINESS_REVIEW_REQUIRED", "需先完成业务复核", 422);
      }
      const approval = await trx
        .selectFrom("package_privacy_approvals")
        .selectAll()
        .where("package_id", "=", pkg.id)
        .executeTakeFirst();
      if (!approval) {
        throw new DomainError("PRIVACY_APPROVAL_REQUIRED", "需先取得隐私批准", 422);
      }

      const currentDigest = await this.computePackageDigest(trx, pkg.id);
      if (currentDigest !== pkg.digest || currentDigest !== approval.digest) {
        throw new DomainError(
          "APPROVAL_VERSION_MISMATCH",
          "批准版本与待放行版本不一致",
          422,
        );
      }
      if (pkg.status !== "approved") {
        throw new DomainError("NOTHING_TO_RELEASE", "包版本状态不允许放行", 422, {
          status: pkg.status,
        });
      }

      const ts = this.now();
      const released = await trx
        .updateTable("delivery_packages")
        .set({ status: "released", released_by: actor, released_at: ts })
        .where("id", "=", pkg.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("preservation_cases")
        .set({ status: "released", released_at: ts })
        .where("id", "=", kase.id)
        .execute();

      await this.custody(trx, kase.id, actor, "PACKAGE_RELEASED", {
        package_id: pkg.id,
        version_no: pkg.version_no,
        digest: currentDigest,
      });
      await this.log(trx, "package.release", actor, kase.id, {
        package_id: pkg.id,
        released_by: actor,
      });
      return released;
    });
  }

  // -- 授权下载 ---------------------------------------------------------

  async issueDownloadLink(
    packageId: string,
    input: { issuedBy: string; expiresAt?: string | null },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const pkg = await trx
        .selectFrom("delivery_packages")
        .selectAll()
        .where("id", "=", packageId)
        .executeTakeFirst();
      if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "交付包不存在", 404);
      if (pkg.status !== "released") {
        throw new DomainError("NOTHING_TO_RELEASE", "仅已放行的包可签发下载地址", 422);
      }
      const token = newId("dl") + sha256(this.now() + packageId + Math.random()).slice(0, 32);
      const link = await trx
        .insertInto("download_links")
        .values({
          id: newId("lnk"),
          case_id: pkg.case_id,
          package_id: pkg.id,
          token_hash: sha256(token),
          issued_by: input.issuedBy,
          issued_at: this.now(),
          expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
          revoked_at: null,
          revoked_by: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.log(trx, "download.issue", input.issuedBy, pkg.case_id, {
        package_id: pkg.id,
        link_id: link.id,
      });
      return { linkId: link.id, token, expiresAt: link.expires_at };
    });
  }

  async revokeDownloadLinks(
    packageId: string,
    input: { actor: string; linkId?: string | null },
  ) {
    return this.db.transaction().execute(async (trx) => {
      const pkg = await trx
        .selectFrom("delivery_packages")
        .selectAll()
        .where("id", "=", packageId)
        .executeTakeFirst();
      if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "交付包不存在", 404);
      let qb = trx
        .updateTable("download_links")
        .set({ revoked_at: this.now(), revoked_by: input.actor })
        .where("package_id", "=", packageId)
        .where("revoked_at", "is", null);
      if (input.linkId) qb = qb.where("id", "=", input.linkId);
      const result = await qb.executeTakeFirstOrThrow();
      const revokedCount = result.numUpdatedRows ? Number(result.numUpdatedRows) : 0;
      await this.log(trx, "download.revoke", input.actor, pkg.case_id, {
        package_id: pkg.id,
        count: revokedCount,
      });
      return { revokedCount };
    });
  }

  /** 凭令牌取包；授权收回立即失效，访问全程留痕。 */
  async downloadByToken(token: string, actor: string) {
    return this.db.transaction().execute(async (trx) => {
      const link = await trx
        .selectFrom("download_links")
        .selectAll()
        .where("token_hash", "=", sha256(token))
        .executeTakeFirst();
      if (!link) throw new DomainError("LINK_INVALID", "下载地址无效", 404);
      if (link.revoked_at) {
        throw new DomainError("LINK_REVOKED", "授权已收回，下载地址失效", 410);
      }
      if (link.expires_at && this.clock().getTime() > Date.parse(link.expires_at)) {
        throw new DomainError("LINK_EXPIRED", "下载地址已过期", 410);
      }
      const bundle = await this.buildBundle(trx, link.package_id);
      await this.log(trx, "download.complete", actor, link.case_id, {
        package_id: link.package_id,
        link_id: link.id,
      });
      return bundle;
    });
  }

  private async buildBundle(trx: EvidenceDatabase, packageId: string) {
    const pkg = await trx
      .selectFrom("delivery_packages")
      .selectAll()
      .where("id", "=", packageId)
      .executeTakeFirstOrThrow();
    const items = await trx
      .selectFrom("manifest_items as i")
      .innerJoin("material_versions as v", "v.id", "i.version_id")
      .innerJoin("material_records as m", "m.id", "i.material_id")
      .select([
        "i.material_id",
        "m.external_key",
        "v.media_type",
        "v.content as original_content",
        "v.content_hash as original_hash",
      ])
      .where("i.manifest_id", "=", pkg.manifest_id)
      .orderBy("m.external_key")
      .execute();
    const redactions = await trx
      .selectFrom("package_redactions")
      .selectAll()
      .where("package_id", "=", packageId)
      .execute();
    const redByMaterial = new Map(redactions.map((r) => [r.material_id, r]));
    const facts = await trx
      .selectFrom("post_freeze_facts")
      .selectAll()
      .where("manifest_id", "=", pkg.manifest_id)
      .orderBy("created_at").orderBy("id")
      .execute();
    const missing = await trx
      .selectFrom("package_missing_items")
      .select(["expected_ref", "reason"])
      .where("package_id", "=", packageId)
      .orderBy("expected_ref").orderBy("id")
      .execute();

    return {
      packageId: pkg.id,
      caseId: pkg.case_id,
      versionNo: pkg.version_no,
      digest: pkg.digest,
      releasedBy: pkg.released_by,
      releasedAt: pkg.released_at,
      files: items.map((i) => {
        const red = redByMaterial.get(i.material_id);
        return {
          materialId: i.material_id,
          externalKey: i.external_key,
          mediaType: i.media_type,
          originalHash: i.original_hash,
          deliveredContent: (red ? red.redacted_content : i.original_content) as Buffer,
          deliveredHash: red ? red.redacted_hash : i.original_hash,
          redacted: Boolean(red),
          changeSummary: red ? red.change_summary : null,
        };
      }),
      facts: facts.map((f) => ({
        type: f.fact_type,
        materialId: f.material_id,
        summary: f.summary,
        contentHash: f.content_hash,
        submittedBy: f.submitted_by,
        createdAt: f.created_at,
      })),
      missingItems: missing.map((m) => ({ expectedRef: m.expected_ref, reason: m.reason })),
    };
  }

  // -- 事后抽查审计 -----------------------------------------------------

  /**
   * 抽查一份已放行包：给出原始版本哈希/内容、遮盖变化、实际放行人，
   * 并重算摘要供核验。
   */
  async auditPackage(packageId: string, actor: string) {
    const pkg = await this.db
      .selectFrom("delivery_packages")
      .selectAll()
      .where("id", "=", packageId)
      .executeTakeFirst();
    if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "交付包不存在", 404);
    const manifest = await this.db
      .selectFrom("manifests")
      .selectAll()
      .where("id", "=", pkg.manifest_id)
      .executeTakeFirstOrThrow();
    const items = await this.db
      .selectFrom("manifest_items as i")
      .innerJoin("material_versions as v", "v.id", "i.version_id")
      .innerJoin("material_records as m", "m.id", "i.material_id")
      .select([
        "i.material_id",
        "m.external_key",
        "v.id as version_id",
        "v.version_no",
        "v.content as original_content",
        "v.content_hash as original_hash",
        "v.submitted_by",
      ])
      .where("i.manifest_id", "=", pkg.manifest_id)
      .orderBy("m.external_key")
      .execute();
    const redactions = await this.db
      .selectFrom("package_redactions")
      .selectAll()
      .where("package_id", "=", pkg.id)
      .execute();
    const redByMaterial = new Map(redactions.map((r) => [r.material_id, r]));
    const facts = await this.db
      .selectFrom("post_freeze_facts")
      .selectAll()
      .where("manifest_id", "=", pkg.manifest_id)
      .orderBy("created_at").orderBy("id")
      .execute();
    const missing = await this.db
      .selectFrom("package_missing_items")
      .select(["expected_ref", "reason"])
      .where("package_id", "=", pkg.id)
      .orderBy("expected_ref").orderBy("id")
      .execute();
    const approval = await this.db
      .selectFrom("package_privacy_approvals")
      .selectAll()
      .where("package_id", "=", pkg.id)
      .executeTakeFirst();
    const recomputed = await this.computePackageDigest(this.db, pkg.id);

    await this.log(this.db, "package.audit", actor, pkg.case_id, { package_id: pkg.id });

    return {
      package: {
        id: pkg.id,
        versionNo: pkg.version_no,
        status: pkg.status,
        digest: pkg.digest,
        digestRecomputed: recomputed,
        digestMatches: safeEqualHex(recomputed, pkg.digest),
        preparedBy: pkg.prepared_by,
        releasedBy: pkg.released_by,
        releasedAt: pkg.released_at,
      },
      privacyApproval: approval
        ? { officer: approval.officer, digest: approval.digest, createdAt: approval.created_at }
        : null,
      manifest: { id: manifest.id, digest: manifest.digest, frozenBy: manifest.frozen_by },
      items: items.map((i) => {
        const red = redByMaterial.get(i.material_id);
        return {
          materialId: i.material_id,
          externalKey: i.external_key,
          original: {
            versionId: i.version_id,
            versionNo: i.version_no,
            hash: i.original_hash,
            content: i.original_content as Buffer,
            submittedBy: i.submitted_by,
          },
          redaction: red
            ? {
                hash: red.redacted_hash,
                content: red.redacted_content as Buffer,
                changeSummary: red.change_summary,
              }
            : null,
        };
      }),
      facts: facts.map((f) => ({
        type: f.fact_type,
        materialId: f.material_id,
        versionId: f.version_id,
        summary: f.summary,
        contentHash: f.content_hash,
        submittedBy: f.submitted_by,
      })),
      missingItems: missing.map((m) => ({ expectedRef: m.expected_ref, reason: m.reason })),
    };
  }

  // -- 常规清理（法律保全豁免） -----------------------------------------

  /**
   * 常规清理：仅物理删除早于水位、已关闭且无法律保全的案件。
   * 法律保全案件一律跳过并计数，绝不触碰。
   */
  async runCleanup(input: { actor: string; olderThan: string }) {
    if (Number.isNaN(Date.parse(input.olderThan))) {
      throw new DomainError("VALIDATION", "older_than 不是合法时间", 400);
    }
    const startedAt = this.now();
    return this.db.transaction().execute(async (trx) => {
      const held = await trx
        .selectFrom("preservation_cases")
        .select("id")
        .where("legal_hold", "=", 1)
        .where("created_at", "<", new Date(input.olderThan).toISOString())
        .execute();
      const deletable = await trx
        .selectFrom("preservation_cases")
        .select("id")
        .where("legal_hold", "=", 0)
        .where("status", "=", "closed")
        .where("created_at", "<", new Date(input.olderThan).toISOString())
        .execute();
      for (const row of deletable) {
        await trx.deleteFrom("preservation_cases").where("id", "=", row.id).execute();
      }
      const run = await trx
        .insertInto("cleanup_runs")
        .values({
          id: newId("cln"),
          actor: input.actor,
          older_than: new Date(input.olderThan).toISOString(),
          deleted_count: deletable.length,
          skipped_hold_count: held.length,
          started_at: startedAt,
          finished_at: this.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.log(trx, "cleanup.run", input.actor, null, {
        deleted: deletable.length,
        skipped_hold: held.length,
        skipped_case_ids: held.map((h) => h.id),
      });
      return run;
    });
  }

  // -- 案件总览 ---------------------------------------------------------

  async getCaseDetail(caseId: string) {
    const kase = await this.getCase(caseId);
    const materials = await this.db
      .selectFrom("material_records as m")
      .innerJoin("material_versions as v", "v.material_id", "m.id")
      .select([
        "m.id as material_id",
        "m.external_key",
        "m.source_type",
        "v.id as version_id",
        "v.version_no",
        "v.status",
        "v.content_hash",
        "v.submitted_by",
        "v.collected_at",
      ])
      .where("m.case_id", "=", caseId)
      .orderBy("m.external_key").orderBy("v.version_no")
      .execute();
    const extensions = await this.db
      .selectFrom("case_deadline_extensions")
      .select(["new_deadline_at", "reason", "requested_by", "created_at"])
      .where("case_id", "=", caseId)
      .orderBy("created_at")
      .execute();
    return { ...kase, materials, extensions };
  }
}
