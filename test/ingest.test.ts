import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/util.js";
import { ACTORS, createHarness, seedFrozenCase, text } from "./helpers.js";

test("接入保存来源摘要、采集时间与保管链", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: { batches: ["B-37"] },
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    const result = await h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("发票内容"),
      sourceSummary: "消费者邮件附件：发票",
      collectedAt: "2026-09-23T10:00:00.000Z",
      receivedBatch: "B-2026-37",
      submittedBy: ACTORS.submitter,
    });
    assert.equal(result.deduplicated, false);

    const detail = await h.service.getCaseDetail(kase.id);
    const material = detail.materials.find((m) => m.external_key === "MAIL-1")!;
    assert.equal(material.collected_at, "2026-09-23T10:00:00.000Z");
    assert.equal(material.status, "current");

    const custody = await h.db
      .selectFrom("custody_events")
      .selectAll()
      .where("case_id", "=", kase.id)
      .orderBy("created_at")
      .execute();
    assert.ok(custody.some((e) => e.event_type === "MATERIAL_RECEIVED"));
    assert.ok(custody.some((e) => e.event_type === "CASE_OPENED"));
  } finally {
    h.close();
  }
});

test("同内容重送沿用已有记录，仅追加保管链事件", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: {},
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    const payload = text("同一附件字节");
    const first = await h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: payload,
      sourceSummary: "批次 A 收到",
      collectedAt: "2026-09-23T10:00:00.000Z",
      receivedBatch: "A",
      submittedBy: ACTORS.submitter,
    });
    // 分散在不同批次的同内容重送（含被撤回后又重发的情形）
    const second = await h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("同一附件字节"),
      sourceSummary: "批次 C 重发",
      collectedAt: "2026-09-23T18:00:00.000Z",
      receivedBatch: "C",
      submittedBy: ACTORS.otherSubmitter,
    });

    assert.equal(second.deduplicated, true);
    assert.equal(second.versionId, first.versionId);

    const versions = await h.db
      .selectFrom("material_versions")
      .selectAll()
      .execute();
    assert.equal(versions.length, 1, "只保留一个版本记录");

    const dedupEvents = await h.db
      .selectFrom("custody_events")
      .selectAll()
      .where("event_type", "=", "REINGEST_DEDUP")
      .execute();
    assert.equal(dedupEvents.length, 1);
    assert.equal(JSON.parse(dedupEvents[0].detail).received_batch, "C");
  } finally {
    h.close();
  }
});

test("同一标识出现异文则隔离等待核查；采纳/驳回后状态正确", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: {},
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    await h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("原始版本"),
      sourceSummary: "原始",
      collectedAt: "2026-09-23T10:00:00.000Z",
      submittedBy: ACTORS.submitter,
    });

    const variantPromise = h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("被替换过的异文版本"),
      sourceSummary: "异文",
      collectedAt: "2026-09-23T11:00:00.000Z",
      submittedBy: ACTORS.otherSubmitter,
    });
    await assert.rejects(variantPromise, (e: DomainError) => e.code === "QUARANTINED_VARIANT");

    let detail = await h.service.getCaseDetail(kase.id);
    const quarantined = detail.materials.find((m) => m.status === "quarantined")!;
    assert.ok(quarantined, "异文已隔离");

    // 采纳异文：旧版本变为 superseded，异文成为 current
    await h.service.resolveQuarantine(quarantined.version_id, {
      decision: "accept",
      actor: ACTORS.liaison,
    });
    detail = await h.service.getCaseDetail(kase.id);
    const statuses = new Set(detail.materials.map((m) => m.status));
    assert.ok(statuses.has("current"));
    assert.ok(statuses.has("superseded"));

    // 再隔离一份并驳回
    const rejected = await h.service.ingestMaterial(kase.id, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("又一异文"),
      sourceSummary: "异文2",
      collectedAt: "2026-09-23T12:00:00.000Z",
      submittedBy: ACTORS.otherSubmitter,
    }).catch((e: DomainError) => {
      if (e.code !== "QUARANTINED_VARIANT") throw e;
      return e.details as { versionId: string };
    });
    await h.service.resolveQuarantine(rejected.versionId, {
      decision: "reject",
      actor: ACTORS.liaison,
    });
    detail = await h.service.getCaseDetail(kase.id);
    assert.ok(detail.materials.some((m) => m.status === "rejected"));
  } finally {
    h.close();
  }
});

test("冻结后的更正、撤回、补件只能追加关联事实", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);

    // 已在清单中的标识出现新内容 -> correction
    const correction = await h.service.ingestMaterial(seeded.caseId, {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      content: text("更正后的发票"),
      sourceSummary: "商家邮件更正发票金额",
      collectedAt: "2026-09-24T09:00:00.000Z",
      receivedBatch: "B-2026-39",
      submittedBy: ACTORS.otherSubmitter,
    });
    assert.equal(correction.appendedFact, "correction");

    // 全新标识 -> supplement
    const supplement = await h.service.ingestMaterial(seeded.caseId, {
      externalKey: "SUP-2",
      sourceType: "merchant_supplement",
      content: text("商家补件说明"),
      sourceSummary: "商家补充情况说明",
      collectedAt: "2026-09-24T09:30:00.000Z",
      submittedBy: ACTORS.otherSubmitter,
    });
    assert.equal(supplement.appendedFact, "supplement");

    // 撤回：清单条目保留
    await h.service.recordWithdrawal(seeded.caseId, {
      externalKey: "CALL-9",
      summary: "热线转写因隐私投诉撤回",
      submittedBy: ACTORS.liaison,
    });

    const manifest = await h.service.getManifest(seeded.caseId);
    assert.equal(manifest.items.length, 2, "冻结清单条目数量不变，撤回不移除");

    const facts = await h.db
      .selectFrom("post_freeze_facts")
      .select(["fact_type", "material_id"])
      .orderBy("created_at")
      .execute();
    assert.deepEqual(
      facts.map((f) => f.fact_type),
      ["correction", "supplement", "withdrawal"],
    );

    // 只追加：不存在 UPDATE/DELETE 路径，验证撤回条目仍为 current 版本
    const detail = await h.service.getCaseDetail(seeded.caseId);
    const callVersions = detail.materials
      .filter((m) => m.external_key === "CALL-9")
      .map((m) => m.status);
    assert.deepEqual(callVersions, ["current"]);
  } finally {
    h.close();
  }
});

test("冻结清单带稳定摘要；重复冻结被拒绝", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    const m1 = await h.service.getManifest(seeded.caseId);
    const m2 = await h.service.getManifest(seeded.caseId);
    assert.equal(m1.digest, m2.digest);
    assert.match(m1.digest, /^[0-9a-f]{64}$/);

    await assert.rejects(
      h.service.freezeManifest(seeded.caseId, ACTORS.liaison),
      (e: DomainError) => e.code === "ALREADY_FROZEN",
    );
  } finally {
    h.close();
  }
});

test("冻结后不得再处理隔离异文", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: {},
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    await h.service.ingestMaterial(kase.id, {
      externalKey: "K",
      sourceType: "email_attachment",
      content: text("v1"),
      sourceSummary: "s",
      collectedAt: "2026-09-23T10:00:00.000Z",
      submittedBy: ACTORS.submitter,
    });
    let quarantinedVersionId = "";
    try {
      await h.service.ingestMaterial(kase.id, {
        externalKey: "K",
        sourceType: "email_attachment",
        content: text("v2"),
        sourceSummary: "s",
        collectedAt: "2026-09-23T11:00:00.000Z",
        submittedBy: ACTORS.submitter,
      });
    } catch (e) {
      quarantinedVersionId = (e as DomainError).details!.versionId;
    }
    await h.service.freezeManifest(kase.id, ACTORS.liaison);
    await assert.rejects(
      h.service.resolveQuarantine(quarantinedVersionId, {
        decision: "accept",
        actor: ACTORS.liaison,
      }),
      (e: DomainError) => e.code === "ALREADY_FROZEN",
    );
  } finally {
    h.close();
  }
});
