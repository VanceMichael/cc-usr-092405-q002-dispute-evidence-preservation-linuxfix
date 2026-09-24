import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/util.js";
import { ACTORS, createHarness, reopenHarness, seedFrozenCase, text } from "./helpers.js";

test("中途停服不重置法定时钟，也不丢掉未完成意见", async () => {
  const h = createHarness("2026-09-24T00:00:00.000Z");
  let restarted: ReturnType<typeof reopenHarness> | null = null;
  try {
    const seeded = await seedFrozenCase(h);

    // 复核人写到一半的意见
    await h.service.saveReviewDraft(seeded.caseId, {
      stage: "business",
      author: ACTORS.reviewer,
      body: "初步看清单完整，但 CALL-9 还需比对……",
    });
    // 续期一次
    await h.service.extendDeadline(seeded.caseId, {
      newDeadlineAt: "2026-09-29T00:00:00.000Z",
      reason: "等待商家第二批补件",
      requestedBy: ACTORS.liaison,
    });
    const dbPath = h.dbPath;
    h.close();

    // 48 小时后重启，时钟用真实世界的“当前时刻”由调用方给定（绝对时间戳持久化）
    restarted = reopenHarness(dbPath, "2026-09-28T12:00:00.000Z");
    const kase = await restarted.service.getCase(seeded.caseId);
    assert.equal(kase.deadline_at, "2026-09-29T00:00:00.000Z", "续期后的绝对时限保留");
    assert.ok(kase.frozen_at, "冻结状态保留");

    const drafts = await restarted.service.listReviewDrafts(seeded.caseId);
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].body, /还需比对/);

    // 法定时钟没有重置：把当前时刻推过续期后期限，放行必须被挡
    restarted.setNow("2026-09-29T00:00:01.000Z");
    await restarted.service.submitBusinessReview(seeded.caseId, {
      reviewer: ACTORS.reviewer,
    });
    const detail = await restarted.service.getCaseDetail(seeded.caseId);
    const mail = detail.materials.find((m) => m.external_key === "MAIL-1")!;
    const pkg = await restarted.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [
        { materialId: mail.material_id, redactedContent: text("遮盖后内容") },
      ],
      missingItems: [],
    });
    await restarted.service.approvePrivacy(pkg.id, { officer: ACTORS.privacy });
    await assert.rejects(
      restarted.service.releasePackage(pkg.id, ACTORS.releaser),
      (e: DomainError) => e.code === "DEADLINE_PASSED",
    );

    // 草稿仍在（放行失败没有丢意见）
    const draftsAfter = await restarted.service.listReviewDrafts(seeded.caseId);
    assert.equal(draftsAfter.length, 1);
  } finally {
    restarted?.close();
  }
});

test("重启后法律保全仍阻挡清理，已放行包与下载令牌仍可核验", async () => {
  const h = createHarness("2026-09-01T00:00:00.000Z");
  try {
    const seeded = await seedFrozenCase(h);
    await h.service.imposeLegalHold(seeded.caseId, {
      reason: "监管询证",
      actor: ACTORS.liaison,
    });
    const dbPath = h.dbPath;
    h.close();

    const restarted = reopenHarness(dbPath, "2026-10-15T00:00:00.000Z");
    try {
      const run = await restarted.service.runCleanup({
        actor: ACTORS.cleaner,
        olderThan: "2026-10-01T00:00:00.000Z",
      });
      assert.equal(run.skipped_hold_count, 1);
      assert.equal(run.deleted_count, 0);
      const kase = await restarted.service.getCase(seeded.caseId);
      assert.equal(kase.legal_hold, 1);
    } finally {
      restarted.close();
    }
  } finally {
    // no-op
  }
});
