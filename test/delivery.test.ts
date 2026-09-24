import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, sha256 } from "../src/domain/util.js";
import { ACTORS, createHarness, maskPii, text } from "./helpers.js";
import { releasedPackage } from "./approval.shared.js";

test("交付包给出稳定摘要与缺件说明；下载内容为隐私批准的遮盖版本", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);

    const audit = await h.service.auditPackage(pkg.id, "auditor.sun");
    assert.equal(audit.package.digestMatches, true, "重算摘要与放行摘要一致");
    assert.equal(audit.package.releasedBy, ACTORS.releaser);

    const mail = audit.items.find((i) => i.externalKey === "MAIL-1")!;
    assert.match(mail.original.content.toString("utf8"), /13800000001/, "抽查可见原始版本");
    assert.ok(mail.redaction, "记录了遮盖变化");
    assert.equal(mail.redaction!.changeSummary, "遮盖消费者手机号");
    assert.doesNotMatch(
      mail.redaction!.content.toString("utf8"),
      /13800000001/,
      "遮盖版本不含手机号",
    );
    assert.equal(
      mail.redaction!.hash,
      sha256(maskPii(text("发票与沟通记录 13800000001"))),
    );

    assert.deepEqual(
      audit.missingItems.map((m) => [m.expectedRef, m.reason] as const),
      [["SUP-9", "商家承诺提供但尚未到达"]],
    );

    const link = await h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser });
    const bundle = await h.service.downloadByToken(link.token, "regulator.browser");
    const deliveredMail = bundle.files.find((f) => f.externalKey === "MAIL-1")!;
    assert.equal(deliveredMail.redacted, true);
    assert.equal(deliveredMail.deliveredHash, mail.redaction!.hash);
    assert.equal(deliveredMail.originalHash, mail.original.hash);
    assert.doesNotMatch(deliveredMail.deliveredContent.toString("utf8"), /13800000001/);

    const callFile = bundle.files.find((f) => f.externalKey === "CALL-9")!;
    assert.equal(callFile.redacted, false);
    assert.equal(callFile.deliveredHash, callFile.originalHash);

    assert.deepEqual(
      bundle.missingItems.map((m) => m.expectedRef),
      ["SUP-9"],
    );
    assert.equal(bundle.releasedBy, ACTORS.releaser);
  } finally {
    h.close();
  }
});

test("访问行为留痕：签发、下载、抽查均有访问日志", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);
    const link = await h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser });
    await h.service.downloadByToken(link.token, "regulator.browser");
    await h.service.auditPackage(pkg.id, "auditor.sun");

    const actions = (
      await h.db.selectFrom("access_logs").select("action").execute()
    ).map((r) => r.action);
    assert.ok(actions.includes("download.issue"));
    assert.ok(actions.includes("download.complete"));
    assert.ok(actions.includes("package.audit"));

    const downloads = await h.db
      .selectFrom("access_logs")
      .selectAll()
      .where("action", "=", "download.complete")
      .execute();
    assert.equal(downloads[0].actor, "regulator.browser");
  } finally {
    h.close();
  }
});

test("授权收回后旧下载地址立即失效（410 LINK_REVOKED）", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);
    const link = await h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser });
    // 收回前可用
    await h.service.downloadByToken(link.token, "regulator.browser");

    const result = await h.service.revokeDownloadLinks(pkg.id, { actor: ACTORS.releaser });
    assert.equal(result.revokedCount, 1);

    await assert.rejects(
      h.service.downloadByToken(link.token, "regulator.browser"),
      (e: DomainError) => e.code === "LINK_REVOKED" && e.statusCode === 410,
    );

    // 重新签发后新地址可用
    const link2 = await h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser });
    const bundle = await h.service.downloadByToken(link2.token, "regulator.browser");
    assert.equal(bundle.packageId, pkg.id);
  } finally {
    h.close();
  }
});

test("下载地址支持到期时间；过期后失效", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);
    const link = await h.service.issueDownloadLink(pkg.id, {
      issuedBy: ACTORS.releaser,
      expiresAt: "2026-09-24T02:00:00.000Z",
    });
    h.setNow("2026-09-24T02:00:01.000Z");
    await assert.rejects(
      h.service.downloadByToken(link.token, "regulator.browser"),
      (e: DomainError) => e.code === "LINK_EXPIRED" && e.statusCode === 410,
    );
  } finally {
    h.close();
  }
});

test("伪造令牌返回 LINK_INVALID", async () => {
  const h = createHarness();
  try {
    const { pkg } = await releasedPackage(h);
    await h.service.issueDownloadLink(pkg.id, { issuedBy: ACTORS.releaser });
    await assert.rejects(
      h.service.downloadByToken("dl_not-a-real-token", "x"),
      (e: DomainError) => e.code === "LINK_INVALID" && e.statusCode === 404,
    );
  } finally {
    h.close();
  }
});

test("事后抽查可核准原始版本、遮盖变化与实际放行人", async () => {
  const h = createHarness();
  try {
    const { pkg, mailMaterialId } = await releasedPackage(h);
    const audit = await h.service.auditPackage(pkg.id, "auditor.sun");
    const mail = audit.items.find((i) => i.materialId === mailMaterialId)!;

    assert.equal(
      mail.original.hash,
      sha256(text("发票与沟通记录 13800000001")),
      "原始版本哈希可核",
    );
    assert.equal(
      mail.redaction!.hash,
      sha256(maskPii(text("发票与沟通记录 13800000001"))),
      "遮盖版本哈希可核",
    );
    assert.notEqual(mail.original.hash, mail.redaction!.hash);
    assert.equal(audit.package.releasedBy, "legal.hao");
    assert.equal(audit.privacyApproval!.officer, ACTORS.privacy);
    assert.equal(audit.privacyApproval!.digest, audit.package.digest);
  } finally {
    h.close();
  }
});
