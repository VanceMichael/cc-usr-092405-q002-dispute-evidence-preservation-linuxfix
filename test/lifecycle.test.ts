import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS, evidenceContent, harness, json, SCOPE } from "./helpers.js";

/**
 * 主流程：建案 → 48 小时法定时钟 → 跨批次采集 → 异文核查 →
 * 冻结清单（含缺件说明）→ 复核 → 同版本遮盖批准 → 放行 → 授权下载。
 */
test("端到端：保全案件经双岗复核后交付稳定摘要与缺件说明，联系方式已遮盖", async () => {
  const h = harness();
  const { app } = h;
  try {
    // 联络员先建立保全案件
    const created = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-2026-0001", title: "批次48小时询证", scope: SCOPE },
    });
    assert.equal(created.status, 201);
    const caseId = created.body.id;

    // 法定时限：48 小时后到期（绝对时间固化）
    const due = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const deadline = await json(app, {
      method: "PUT",
      url: `/cases/${caseId}/deadline`,
      headers: ACTORS.liaison,
      body: { due_at: due },
    });
    assert.equal(deadline.status, 200);
    assert.equal(deadline.body.due_at, due);
    assert.equal(deadline.body.status, "active");

    // 跨批次接入：邮件附件、热线转写、商家补件（分散在不同批次也能汇齐）
    const ingestOne = async (source_key: string, source_native_id: string, phone: string, batch: string) =>
      json(app, {
        method: "POST",
        url: `/cases/${caseId}/ingest`,
        headers: ACTORS.liaison,
        body: {
          source_key,
          source_native_id,
          content: evidenceContent(phone),
          media_type: "application/json",
          source_summary: { batch, subject: "退款争议", filename: `${source_native_id}.json` },
        },
      });

    const email = await ingestOne("email", "ATT-1001", "13800000001", "batch-A");
    assert.equal(email.status, 200);
    assert.equal(email.body.outcome, "ingested");
    await ingestOne("hotline", "CALL-2002", "13800000002", "batch-B");
    await ingestOne("merchant", "DOC-3003", "13800000003", "batch-C");

    // 邮件异文（撤回后重发的新版本）→ 隔离，复核人核查后采信新版本
    const variant = await ingestOne("email", "ATT-1001", "13900000099", "batch-A-重发");
    assert.equal(variant.status, 200);
    assert.equal(variant.body.outcome, "quarantined");
    const resolve = await json(app, {
      method: "POST",
      url: `/items/${email.body.itemId}/quarantine-resolution`,
      headers: ACTORS.reviewer,
      body: { decision: "admit", record_id: variant.body.recordId },
    });
    assert.equal(resolve.status, 200);

    // 联络员冻结清单：3 份在范围 + 1 份缺件（ATT-1099 未采集）
    const freeze = await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    assert.equal(freeze.status, 200);
    assert.equal(freeze.body.entry_count, 3);
    assert.deepEqual(
      freeze.body.missing_items.map((m: any) => m.source_native_id),
      ["ATT-1099"],
    );
    assert.equal(freeze.body.missing_items[0].reason, "not_collected");
    const manifestHash = freeze.body.manifest_hash;

    // 冻结不可重复
    const refreeze = await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    assert.equal(refreeze.status, 409);
    assert.equal(refreeze.body.error.code, "MANIFEST_ALREADY_FROZEN");

    // 业务复核人确认清单完整（不能是采集人本人 —— 由专门用例验证）
    const review = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.reviewer,
      body: { decision: "complete", note: "三份在范围材料齐整，缺件已列明" },
    });
    assert.equal(review.status, 200);

    // 隐私专员基于同一冻结版本批准遮盖消费者联系方式
    const redaction = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/redactions`,
      headers: ACTORS.privacy,
      body: { rules: [{ field_path: "consumer.phone" }, { field_path: "consumer.name" }] },
    });
    assert.equal(redaction.status, 200);
    assert.equal(redaction.body.manifest_id, freeze.body.manifestId);

    // 放行人出具交付包
    const release = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(release.status, 201);
    assert.equal(release.body.manifest_hash, manifestHash);
    assert.match(release.body.package_hash, /^[0-9a-f]{64}$/);
    assert.equal(release.body.released_by, "releaser-1");
    assert.deepEqual(
      release.body.missing_items.map((m: any) => m.source_native_id),
      ["ATT-1099"],
    );
    const packageId = release.body.package_id;

    // 签发限时下载地址
    const grant = await json(app, { method: "POST", url: `/packages/${packageId}/grants`, headers: ACTORS.releaser });
    assert.equal(grant.status, 201);
    assert.ok(grant.body.token);

    // 监管侧下载：联系方式被遮盖，原始 hash 与交付 hash 同时给出
    const download = await json(app, { method: "GET", url: `/downloads/${grant.body.token}`, headers: ACTORS.admin });
    assert.equal(download.status, 200);
    assert.equal(download.body.package_hash, release.body.package_hash);
    const emailEntry = download.body.entries.find((e: any) => e.source_native_id === "ATT-1001");
    const payload = JSON.parse(Buffer.from(emailEntry.content_base64, "base64").toString("utf8"));
    assert.equal(payload.consumer.phone, "【已遮盖】");
    assert.equal(payload.consumer.name, "【已遮盖】");
    assert.notEqual(emailEntry.source_record_hash, emailEntry.delivered_hash);
    assert.deepEqual(emailEntry.changed_fields.sort(), ["consumer.name", "consumer.phone"]);
    // 异文采信后交付的是新版本（139 号码），但原始版本 hash 仍可追溯
    assert.equal(JSON.parse(Buffer.from(emailEntry.content_base64, "base64").toString("utf8")).body, "争议材料正文");
  } finally {
    await h.close();
  }
});

test("回避规则：采集人本人不能复核、批准遮盖或放行自己提交的材料", async () => {
  const h = harness();
  const { app } = h;
  try {
    const created = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-2026-0002", title: "自审禁止", scope: SCOPE },
    });
    const caseId = created.body.id;
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("138"), source_summary: { batch: "b" } },
    });
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "hotline", source_native_id: "CALL-2002", content: evidenceContent("139"), source_summary: { batch: "b" } },
    });
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "merchant", source_native_id: "DOC-3003", content: evidenceContent("137"), source_summary: { batch: "b" } },
    });
    await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });

    // liaison-1 同时持有审批角色，但人是采集人 → 三道审批全部拒绝
    const review = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.samePerson,
      body: { decision: "complete" },
    });
    assert.equal(review.status, 403);
    assert.equal(review.body.error.code, "SELF_APPROVAL_FORBIDDEN");

    const redaction = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/redactions`,
      headers: ACTORS.samePerson,
      body: { rules: [] },
    });
    assert.equal(redaction.status, 403);
    assert.equal(redaction.body.error.code, "SELF_APPROVAL_FORBIDDEN");

    // 没有合格复核时放行也会被挡；先让别人复核与批准遮盖，再由本人放行 → 仍拒绝
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.reviewer,
      body: { decision: "complete" },
    });
    await json(app, { method: "POST", url: `/cases/${caseId}/redactions`, headers: ACTORS.privacy, body: { rules: [] } });
    const release = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.samePerson });
    assert.equal(release.status, 403);
    assert.equal(release.body.error.code, "SELF_APPROVAL_FORBIDDEN");
  } finally {
    await h.close();
  }
});

test("门禁：无身份头 401、角色不足 403、无复核或复核不完整不能放行", async () => {
  const h = harness();
  const { app } = h;
  try {
    const noActor = await json(app, { method: "POST", url: "/cases", body: { case_no: "x", title: "x", scope: SCOPE } });
    assert.equal(noActor.status, 401);
    assert.equal(noActor.body.error.code, "ACTOR_REQUIRED");

    const created = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-2026-0003", title: "门禁", scope: SCOPE },
    });
    const caseId = created.body.id;
    const reviewerCreates = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.reviewer,
      body: { source_key: "email", source_native_id: "ATT-1001", content: "{}", source_summary: {} },
    });
    assert.equal(reviewerCreates.status, 403);
    assert.equal(reviewerCreates.body.error.code, "FORBIDDEN_ROLE");

    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("1"), source_summary: { batch: "b" } },
    });
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "hotline", source_native_id: "CALL-2002", content: evidenceContent("2"), source_summary: { batch: "b" } },
    });
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "merchant", source_native_id: "DOC-3003", content: evidenceContent("3"), source_summary: { batch: "b" } },
    });
    await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });

    // 未复核
    const noReview = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(noReview.status, 400);

    // 复核不完整
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.reviewer,
      body: { decision: "incomplete", note: "商家补件页码缺失" },
    });
    const incomplete = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(incomplete.status, 409);
    assert.equal(incomplete.body.error.code, "REVIEW_INCOMPLETE");

    // 未批准遮盖
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.reviewer,
      body: { decision: "complete" },
    });
    const noRedaction = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(noRedaction.status, 409);
    assert.equal(noRedaction.body.error.code, "REDACTION_NOT_APPROVED");

    // 遮盖必须基于冻结版本：冻结前批准直接拒绝
    const fresh = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-2026-0003b", title: "未冻结", scope: SCOPE },
    });
    const beforeFreeze = await json(app, {
      method: "POST",
      url: `/cases/${fresh.body.id}/redactions`,
      headers: ACTORS.privacy,
      body: { rules: [] },
    });
    assert.equal(beforeFreeze.status, 409);
    assert.equal(beforeFreeze.body.error.code, "MANIFEST_NOT_FROZEN");
  } finally {
    await h.close();
  }
});
