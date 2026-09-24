import { ACTORS, type Harness, maskPii, seedFrozenCase, text } from "./helpers.js";

/** 业务复核 → 制备遮盖包（含缺件说明）→ 隐私批准 → 放行 的完整链路。 */
export async function releasedPackage(h: Harness) {
  const seeded = await seedFrozenCase(h);

  await h.service.submitBusinessReview(seeded.caseId, {
    reviewer: ACTORS.reviewer,
    comment: "清单与争议范围一致，材料完整",
  });

  const detail = await h.service.getCaseDetail(seeded.caseId);
  const mail = detail.materials.find((m) => m.external_key === "MAIL-1")!;

  const pkg = await h.service.preparePackage(seeded.caseId, {
    preparedBy: ACTORS.liaison,
    redactions: [
      {
        materialId: mail.material_id,
        redactedContent: maskPii(text("发票与沟通记录 13800000001")),
        changeSummary: "遮盖消费者手机号",
      },
    ],
    missingItems: [{ expectedRef: "SUP-9", reason: "商家承诺提供但尚未到达" }],
  });

  await h.service.approvePrivacy(pkg.id, {
    officer: ACTORS.privacy,
    comment: "批准按当前版本遮盖手机号",
  });
  const released = await h.service.releasePackage(pkg.id, ACTORS.releaser);
  return { seeded, pkg: released, mailMaterialId: mail.material_id };
}
