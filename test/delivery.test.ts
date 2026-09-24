import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS, evidenceContent, harness, json, SCOPE } from "./helpers.js";

async function deliveredCase(app: any, overrides: { rules?: any[] } = {}) {
  const created = await json(app, {
    method: "POST",
    url: "/cases",
    headers: ACTORS.liaison,
    body: {
      case_no: `D-${Math.random().toString(36).slice(2, 8)}`,
      title: "交付用例",
      scope: SCOPE,
      retention_until: "2030-01-01T00:00:00.000Z",
    },
  });
  const caseId = created.body.id;
  const ingest = (source_key: string, source_native_id: string, phone: string) =>
    json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key, source_native_id, content: evidenceContent(phone), media_type: "application/json", source_summary: { batch: "b" } },
    });
  await ingest("email", "ATT-1001", "13800000001");
  await ingest("hotline", "CALL-2002", "13800000002");
  await ingest("merchant", "DOC-3003", "13800000003");
  await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
  await json(app, { method: "POST", url: `/cases/${caseId}/reviews`, headers: ACTORS.reviewer, body: { decision: "complete" } });
  await json(app, {
    method: "POST",
    url: `/cases/${caseId}/redactions`,
    headers: ACTORS.privacy,
    body: { rules: overrides.rules ?? [{ field_path: "consumer.phone" }] },
  });
  const release = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
  return { caseId, packageId: release.body.package_id, release: release.body, manifestId: (release.body as any).manifest_id };
}

test("授权收回后旧下载地址立即失效；无效与过期 token 同样拒绝，且每次尝试留痕", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const { packageId } = await deliveredCase(app);
    const grant = await json(app, { method: "POST", url: `/packages/${packageId}/grants`, headers: ACTORS.releaser });
    assert.equal(grant.status, 201);

    const ok = await json(app, { method: "GET", url: `/downloads/${grant.body.token}`, headers: ACTORS.admin });
    assert.equal(ok.status, 200);

    // 无效 token
    const bad = await json(app, { method: "GET", url: "/downloads/not-a-real-token", headers: ACTORS.admin });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error.code, "DOWNLOAD_DENIED");

    // 签发即过期的授权
    const expiredGrant = await json(app, {
      method: "POST",
      url: `/packages/${packageId}/grants`,
      headers: ACTORS.releaser,
      body: { ttl_seconds: -10 },
    });
    const expired = await json(app, { method: "GET", url: `/downloads/${expiredGrant.body.token}`, headers: ACTORS.admin });
    assert.equal(expired.status, 403);
    assert.match(expired.body.error.message, /过期/);

    // 收回授权：旧地址立即失效
    const revoke = await json(app, { method: "POST", url: `/grants/${grant.body.grant_id}/revoke`, headers: ACTORS.releaser });
    assert.equal(revoke.status, 200);
    const afterRevoke = await json(app, { method: "GET", url: `/downloads/${grant.body.token}`, headers: ACTORS.admin });
    assert.equal(afterRevoke.status, 403);
    assert.match(afterRevoke.body.error.message, /收回/);

    // 数据库只存 token 散列，不存明文
    const stored = db.prepare("SELECT token_hash, status FROM download_grants WHERE id = ?").get(grant.body.grant_id) as any;
    assert.equal(stored.status, "revoked");
    assert.notEqual(stored.token_hash, grant.body.token);

    // 留痕：成功 + 三次拒绝
    const logs = db
      .prepare("SELECT outcome, detail FROM access_logs WHERE action = 'package.download' ORDER BY created_at")
      .all() as any[];
    const outcomes = logs.map((l) => l.outcome);
    assert.deepEqual(outcomes, ["success", "denied", "denied", "denied"]);
    assert.deepEqual(logs.slice(1).map((l) => JSON.parse(l.detail).reason), ["invalid_token", "expired", "revoked"]);
  } finally {
    await h.close();
  }
});

test("法律保全生效时常规清理跳过相关内容；解除后才可清理", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const past = "2020-01-01T00:00:00.000Z";
    // 两起均过保留期的案件：一起加法律保全，一起不加
    const held = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-HOLD", title: "保全中", scope: SCOPE, retention_until: past },
    });
    const unheld = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-EXPIRE", title: "可清理", scope: SCOPE, retention_until: past },
    });

    const hold = await json(app, {
      method: "POST",
      url: `/cases/${held.body.id}/legal-holds`,
      headers: ACTORS.admin,
      body: { reason: "进入行政复议，依法保全" },
    });
    assert.equal(hold.status, 201);

    const cleanup1 = await json(app, { method: "POST", url: "/admin/cleanup", headers: ACTORS.admin });
    assert.equal(cleanup1.status, 200);
    assert.deepEqual(cleanup1.body.skipped_holds, [held.body.id]);
    assert.deepEqual(cleanup1.body.deleted, [unheld.body.id]);
    // 保全案件的全部内容仍在
    assert.ok(db.prepare("SELECT id FROM cases WHERE id = ?").get(held.body.id));

    // 非 admin 不能跑清理
    const forbidden = await json(app, { method: "POST", url: "/admin/cleanup", headers: ACTORS.liaison });
    assert.equal(forbidden.status, 403);

    // 解除保全后清理生效
    await json(app, { method: "POST", url: `/legal-holds/${hold.body.id}/release`, headers: ACTORS.admin });
    const cleanup2 = await json(app, { method: "POST", url: "/admin/cleanup", headers: ACTORS.admin });
    assert.deepEqual(cleanup2.body.deleted, [held.body.id]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cases").get() as any).n, 0);
  } finally {
    await h.close();
  }
});

test("事后抽查：可核准原始版本、遮盖变化、实际放行人与授权留痕；包摘要稳定", async () => {
  const h = harness();
  const { app } = h;
  try {
    const { caseId, packageId, release } = await deliveredCase(app, {
      rules: [{ field_path: "consumer.phone" }, { field_path: "consumer.name" }],
    });

    // 冻结后追加一条更正，重新放行后应出现在抽查结果中
    const emailItem = await (async () => {
      const list = await json(app, { method: "GET", url: `/cases/${caseId}`, headers: ACTORS.admin });
      return list;
    })();
    assert.equal(emailItem.status, 200);

    const grant = await json(app, { method: "POST", url: `/packages/${packageId}/grants`, headers: ACTORS.releaser });
    await json(app, { method: "GET", url: `/downloads/${grant.body.token}`, headers: ACTORS.admin });

    const audit = await json(app, { method: "GET", url: `/packages/${packageId}/audit`, headers: ACTORS.admin });
    assert.equal(audit.status, 200);
    const a = audit.body;

    // 实际放行人
    assert.equal(a.package.released_by, "releaser-1");
    assert.equal(a.package.package_hash, release.package_hash);
    // 冻结人、复核人、遮盖批准人三岗分离可核
    assert.equal(a.manifest.frozen_by, "liaison-1");
    assert.equal(a.review.reviewer_id, "reviewer-1");
    assert.equal(a.redaction.approved_by, "privacy-1");

    // 每份材料：原始版本 hash + 采集人 + 交付 hash + 遮盖字段
    assert.equal(a.entries.length, 3);
    for (const entry of a.entries) {
      assert.match(entry.original_record.content_hash, /^[0-9a-f]{64}$/);
      assert.equal(entry.original_record.collected_by, "liaison-1");
      assert.notEqual(entry.source_record_hash, entry.delivered_hash);
      assert.ok(entry.changed_fields.includes("consumer.phone"));
    }

    // 授权与下载留痕
    assert.equal(a.grants.length, 1);
    assert.equal(a.grants[0].status, "active");
    const downloadLogs = a.access_logs.filter((l: any) => l.action === "package.download");
    assert.ok(downloadLogs.some((l: any) => l.outcome === "success"));

    // 缺件说明随包
    assert.deepEqual(a.package.missing_items.map((m: any) => m.source_native_id), ["ATT-1099"]);

    // 同状态再次放行：稳定摘要逐字节一致（确定性序列化）
    const second = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(second.body.package_hash, release.package_hash);
  } finally {
    await h.close();
  }
});

test("冻结后的更正随包交付并计入稳定摘要，且交付内容复算 hash 一致", async () => {
  const h = harness();
  const { app } = h;
  try {
    const created = await json(app, {
      method: "POST",
      url: "/cases",
      headers: ACTORS.liaison,
      body: { case_no: "D-FACTS-DELIVER", title: "追加交付", scope: SCOPE },
    });
    const caseId = created.body.id;
    const email = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("13800000001", "原件"), media_type: "application/json", source_summary: { batch: "b" } },
    });
    for (const [k, i] of [["hotline", "CALL-2002"], ["merchant", "DOC-3003"]] as const) {
      await json(app, {
        method: "POST",
        url: `/cases/${caseId}/ingest`,
        headers: ACTORS.liaison,
        body: { source_key: k, source_native_id: i, content: evidenceContent("13800000000"), media_type: "application/json", source_summary: { batch: "b" } },
      });
    }
    await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    // 冻结后追加更正
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/linked-facts`,
      headers: ACTORS.liaison,
      body: {
        kind: "correction",
        relates_to_item_id: email.body.itemId,
        note: "更正金额",
        evidence: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("13800000001", "更正件"), media_type: "application/json", source_summary: { batch: "post" } },
      },
    });
    await json(app, { method: "POST", url: `/cases/${caseId}/reviews`, headers: ACTORS.reviewer, body: { decision: "complete" } });
    await json(app, { method: "POST", url: `/cases/${caseId}/redactions`, headers: ACTORS.privacy, body: { rules: [{ field_path: "consumer.phone" }] } });
    const release = await json(app, { method: "POST", url: `/cases/${caseId}/packages`, headers: ACTORS.releaser });
    assert.equal(release.body.linked_fact_count, 1);

    const grant = await json(app, { method: "POST", url: `/packages/${release.body.package_id}/grants`, headers: ACTORS.releaser });
    const download = await json(app, { method: "GET", url: `/downloads/${grant.body.token}`, headers: ACTORS.admin });
    assert.equal(download.body.linked_facts.length, 1);
    const fact = download.body.linked_facts[0];
    assert.equal(fact.kind, "correction");
    const factPayload = JSON.parse(Buffer.from(fact.content_base64, "base64").toString("utf8"));
    assert.equal(factPayload.body, "更正件");
    assert.equal(factPayload.consumer.phone, "【已遮盖】");

    // 交付内容与放行时固化的 hash 一致（服务端下载时也会复算校验）
    const { createHash } = await import("node:crypto");
    const recomputed = createHash("sha256").update(Buffer.from(fact.content_base64, "base64")).digest("hex");
    assert.equal(recomputed, fact.delivered_hash);
    assert.notEqual(fact.source_record_hash, fact.delivered_hash);
  } finally {
    await h.close();
  }
});
