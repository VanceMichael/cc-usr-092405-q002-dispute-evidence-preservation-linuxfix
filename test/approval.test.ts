import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/util.js";
import { ACTORS, createHarness, maskPii, seedFrozenCase, text } from "./helpers.js";
import { releasedPackage } from "./approval.shared.js";

test("业务复核 + 隐私批准（同一版本）+ 时限内，才能放行", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);
    assert.equal(pkg.status, "released");
  } finally {
    h.close();
  }
});

test("放行人不能是材料提交人或包制备人", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    const detail = await h.service.getCaseDetail(seeded.caseId);
    const mail = detail.materials.find((m) => m.external_key === "MAIL-1")!;
    const pkg = await h.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [
        { materialId: mail.material_id, redactedContent: maskPii(text("发票与沟通记录 13800000001")) },
      ],
      missingItems: [],
    });
    await h.service.approvePrivacy(pkg.id, { officer: ACTORS.privacy });
    // liaison 既是制备人又是 MAIL-1 的提交人
    await assert.rejects(
      h.service.releasePackage(pkg.id, ACTORS.liaison),
      (e: DomainError) => e.code === "SELF_APPROVAL_FORBIDDEN" && e.statusCode === 403,
    );
  } finally {
    h.close();
  }
});

test("任何人都不能审批自己提交的材料（业务复核与隐私批准均拦截）", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);

    // liaison 提交了 MAIL-1，不能做业务复核
    await assert.rejects(
      h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.liaison }),
      (e: DomainError) => e.code === "SELF_APPROVAL_FORBIDDEN" && e.statusCode === 403,
    );

    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    const detail = await h.service.getCaseDetail(seeded.caseId);
    const mail = detail.materials.find((m) => m.external_key === "MAIL-1")!;
    const pkg = await h.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [
        { materialId: mail.material_id, redactedContent: maskPii(text("发票与沟通记录 13800000001")) },
      ],
      missingItems: [],
    });

    // 提交人不能做隐私批准
    await assert.rejects(
      h.service.approvePrivacy(pkg.id, { officer: ACTORS.liaison }),
      (e: DomainError) => e.code === "SELF_APPROVAL_FORBIDDEN",
    );
    // 制备人也不能批准自己的包
    await assert.rejects(
      h.service.approvePrivacy(pkg.id, { officer: ACTORS.liaison }),
      (e: DomainError) => e.code === "SELF_APPROVAL_FORBIDDEN",
    );
  } finally {
    h.close();
  }
});

test("隐私批准必须基于同一版本：批准后追加事实使旧包失效", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    const detail = await h.service.getCaseDetail(seeded.caseId);
    const mail = detail.materials.find((m) => m.external_key === "MAIL-1")!;
    const pkg = await h.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [
        { materialId: mail.material_id, redactedContent: maskPii(text("发票与沟通记录 13800000001")) },
      ],
      missingItems: [],
    });
    await h.service.approvePrivacy(pkg.id, { officer: ACTORS.privacy });

    // 冻结后新到的补件会使尚未放行的已批准包变为 superseded
    await h.service.ingestMaterial(seeded.caseId, {
      externalKey: "SUP-3",
      sourceType: "merchant_supplement",
      content: text("新补件"),
      sourceSummary: "新增补件",
      collectedAt: "2026-09-24T15:00:00.000Z",
      submittedBy: ACTORS.otherSubmitter,
    });

    await assert.rejects(
      h.service.releasePackage(pkg.id, ACTORS.releaser),
      (e: DomainError) => e.code === "APPROVAL_VERSION_MISMATCH" || e.code === "NOTHING_TO_RELEASE",
    );
  } finally {
    h.close();
  }
});

test("未完成业务复核不能制备包；未隐私批准不能放行；超过时限不能放行", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    await assert.rejects(
      h.service.preparePackage(seeded.caseId, {
        preparedBy: ACTORS.liaison,
        redactions: [],
        missingItems: [],
      }),
      (e: DomainError) => e.code === "BUSINESS_REVIEW_REQUIRED",
    );

    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    const pkg = await h.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [],
      missingItems: [],
    });
    await assert.rejects(
      h.service.releasePackage(pkg.id, ACTORS.releaser),
      (e: DomainError) => e.code === "PRIVACY_APPROVAL_REQUIRED",
    );
    await h.service.approvePrivacy(pkg.id, { officer: ACTORS.privacy });

    h.setNow("2026-09-27T00:00:01.000Z"); // 超过法定时限
    await assert.rejects(
      h.service.releasePackage(pkg.id, ACTORS.releaser),
      (e: DomainError) => e.code === "DEADLINE_PASSED",
    );
  } finally {
    h.close();
  }
});

test("业务复核每案只能进行一次", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    await assert.rejects(
      h.service.submitBusinessReview(seeded.caseId, { reviewer: "reviewer.zhao" }),
      (e: DomainError) => e.code === "ALREADY_REVIEWED",
    );
  } finally {
    h.close();
  }
});

test("未放行包不能签发下载地址", async () => {
  const h = createHarness();
  try {
    const seeded = await seedFrozenCase(h);
    await h.service.submitBusinessReview(seeded.caseId, { reviewer: ACTORS.reviewer });
    const pkg = await h.service.preparePackage(seeded.caseId, {
      preparedBy: ACTORS.liaison,
      redactions: [],
      missingItems: [],
    });
    await assert.rejects(
      h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser }),
      (e: DomainError) => e.code === "NOTHING_TO_RELEASE",
    );
  } finally {
    h.close();
  }
});
