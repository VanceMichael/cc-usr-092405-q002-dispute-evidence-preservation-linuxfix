import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS, evidenceContent, harness, json, SCOPE } from "./helpers.js";
import { EvidenceService } from "../src/domain/service.js";

async function seedCase(app: any, caseNo = "D-INGEST") {
  const created = await json(app, {
    method: "POST",
    url: "/cases",
    headers: ACTORS.liaison,
    body: { case_no: caseNo, title: "采集完整性", scope: SCOPE },
  });
  return created.body.id;
}

test("同内容重送沿用已有记录，不产生新版本；撤回材料与原件同标识异文则隔离", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const caseId = await seedCase(app);
    const payload = evidenceContent("13800000001", "初版");

    const first = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1", content: payload, source_summary: { batch: "batch-A" } },
    });
    assert.equal(first.body.outcome, "ingested");

    // 不同批次重送完全相同内容 → 去重，沿用同一 record
    const resent = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1", content: payload, source_summary: { batch: "batch-B" } },
    });
    assert.equal(resent.status, 200);
    assert.equal(resent.body.outcome, "dedup");
    assert.equal(resent.body.recordId, first.body.recordId);

    const recordCount = db
      .prepare("SELECT COUNT(*) AS n FROM evidence_records WHERE item_id = ?")
      .get(first.body.itemId) as any;
    assert.equal(recordCount.n, 1);

    // 保管链记录了重送去重事件
    const dedupEvents = db
      .prepare("SELECT COUNT(*) AS n FROM custody_events WHERE item_id = ? AND event_type = 'resent_dedup'")
      .get(first.body.itemId) as any;
    assert.equal(dedupEvents.n, 1);

    // 同一标识、不同内容（撤回后补发）→ 隔离
    const variant = await json(app, {
      method: "POST",
      url: `/cases/${caseId}/ingest`,
      headers: ACTORS.liaison,
      body: { source_key: "email", source_native_id: "ATT-1", content: evidenceContent("13800000001", "撤回后新版"), source_summary: { batch: "batch-C" } },
    });
    assert.equal(variant.body.outcome, "quarantined");
    const item = db.prepare("SELECT * FROM evidence_items WHERE id = ?").get(first.body.itemId) as any;
    assert.equal(item.status, "quarantined");
    // 新版本确实已保全入库（不会丢失被撤回过的材料），但尚未采信
    const versions = db.prepare("SELECT * FROM evidence_records WHERE item_id = ? ORDER BY collected_at").all(first.body.itemId) as any[];
    assert.equal(versions.length, 2);
  } finally {
    await h.close();
  }
});

test("隔离材料未核查时冻结清单将其列为缺件；核查驳回则维持排除", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const caseId = await seedCase(app, "D-QUAR");
    const base = { headers: ACTORS.liaison };
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("1"), source_summary: { batch: "b" } } });
    // 异文致隔离
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("2"), source_summary: { batch: "b2" } } });
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "hotline", source_native_id: "CALL-2002", content: evidenceContent("3"), source_summary: { batch: "b" } } });
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "merchant", source_native_id: "DOC-3003", content: evidenceContent("4"), source_summary: { batch: "b" } } });

    const itemId = (db.prepare("SELECT id FROM evidence_items WHERE source_native_id = 'ATT-1001'").get() as any).id;
    const freeze = await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    assert.equal(freeze.body.entry_count, 2);
    const quarMissing = freeze.body.missing_items.find((m: any) => m.source_native_id === "ATT-1001");
    assert.equal(quarMissing.reason, "quarantined_pending");
    assert.ok(freeze.body.missing_items.some((m: any) => m.source_native_id === "ATT-1099"));

    // 复核人驳回异文 → 材料维持排除（清单已冻结不可变，驳回只产生保管链事件）
    const reject = await json(app, {
      method: "POST",
      url: `/items/${itemId}/quarantine-resolution`,
      headers: ACTORS.reviewer,
      body: { decision: "reject" },
    });
    assert.equal(reject.status, 200);
    const item = db.prepare("SELECT * FROM evidence_items WHERE id = ?").get(itemId) as any;
    assert.equal(item.status, "quarantined");
  } finally {
    await h.close();
  }
});

test("冻结后的更正、撤回、补件只能追加关联事实，冻结版本与清单摘要不变", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const caseId = await seedCase(app, "D-FACTS");
    const base = { headers: ACTORS.liaison };
    const email = await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("13800000001", "原陈述"), source_summary: { batch: "b" } } });
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "hotline", source_native_id: "CALL-2002", content: evidenceContent("13800000002"), source_summary: { batch: "b" } } });
    await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "merchant", source_native_id: "DOC-3003", content: evidenceContent("13800000003"), source_summary: { batch: "b" } } });
    const freeze = await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    const frozenHash = freeze.body.manifest_hash;

    // 冻结后直接接入应被拒绝
    const direct = await json(app, { ...base, method: "POST", url: `/cases/${caseId}/ingest`, body: { source_key: "email", source_native_id: "ATT-1001", content: "新版", source_summary: { batch: "post" } } });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.error.code, "FROZEN_APPEND_ONLY");

    // 更正：同标识新内容，作为关联事实追加，不触发隔离、不改冻结当前版本
    const correction = await json(app, {
      ...base,
      method: "POST",
      url: `/cases/${caseId}/linked-facts`,
      body: {
        kind: "correction",
        relates_to_item_id: email.body.itemId,
        note: "商家来函更正订单金额",
        evidence: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("13800000001", "更正陈述"), source_summary: { batch: "post-freeze" } },
      },
    });
    assert.equal(correction.status, 200);
    assert.equal(correction.body.kind, "correction");

    // 撤回：无需新材料，撤回声明本身留痕
    const withdrawal = await json(app, {
      ...base,
      method: "POST",
      url: `/cases/${caseId}/linked-facts`,
      body: { kind: "withdrawal", relates_to_item_id: email.body.itemId, note: "消费者撤回该附件的个人信息授权" },
    });
    assert.equal(withdrawal.status, 200);
    assert.equal(withdrawal.body.kind, "withdrawal");

    // 补件：冻结后新出现的材料
    const supplement = await json(app, {
      ...base,
      method: "POST",
      url: `/cases/${caseId}/linked-facts`,
      body: {
        kind: "supplement",
        note: "商家补交盖章说明",
        evidence: { source_key: "merchant", source_native_id: "DOC-3099", content: evidenceContent("13800000009", "补件"), source_summary: { batch: "post-freeze" } },
      },
    });
    assert.equal(supplement.status, 200);

    // 冻结清单与摘要保持不变
    const manifest = db.prepare("SELECT * FROM frozen_manifests WHERE case_id = ?").get(caseId) as any;
    assert.equal(manifest.manifest_hash, frozenHash);
    const emailItem = db.prepare("SELECT current_record_id, status FROM evidence_items WHERE id = ?").get(email.body.itemId) as any;
    assert.equal(emailItem.status, "admitted");
    assert.equal(emailItem.current_record_id, email.body.recordId);
    const facts = db.prepare("SELECT kind FROM linked_facts WHERE case_id = ? ORDER BY created_at").all(caseId) as any[];
    assert.deepEqual(facts.map((f) => f.kind), ["correction", "withdrawal", "supplement"]);
  } finally {
    await h.close();
  }
});

test("法定时限续期必须带理由，旧时限置 superseded 且不回改；未完成意见持久化", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const caseId = await seedCase(app, "D-DEAD");
    const firstDue = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const set1 = await json(app, { method: "PUT", url: `/cases/${caseId}/deadline`, headers: ACTORS.liaison, body: { due_at: firstDue } });
    assert.equal(set1.status, 200);

    // 无理由续期 → 拒绝
    const secondDue = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
    const noReason = await json(app, { method: "PUT", url: `/cases/${caseId}/deadline`, headers: ACTORS.liaison, body: { due_at: secondDue } });
    assert.equal(noReason.status, 422);
    assert.equal(noReason.body.error.code, "DEADLINE_EXTENSION_REASON_REQUIRED");

    // 带理由续期
    const extended = await json(app, {
      method: "PUT",
      url: `/cases/${caseId}/deadline`,
      headers: ACTORS.liaison,
      body: { due_at: secondDue, reason: "商家补件跨周末，监管同意顺延 48 小时" },
    });
    assert.equal(extended.status, 200);
    assert.equal(extended.body.due_at, secondDue);
    assert.equal(extended.body.extended_from_id, set1.body.id);

    const all = db.prepare("SELECT * FROM deadlines WHERE case_id = ? ORDER BY created_at").all(caseId) as any[];
    assert.equal(all.length, 2);
    assert.equal(all[0].status, "superseded");
    assert.equal(all[0].due_at, firstDue); // 旧记录不回改
    assert.equal(all[1].status, "active");
    assert.equal(all[1].reason, "商家补件跨周末，监管同意顺延 48 小时");
  } finally {
    await h.close();
  }
});

test("进程停服重启：法定时钟按绝对时间继续走，隔离版本与未完成意见都不丢", async () => {
  const h = harness();
  const { app, db } = h;
  try {
    const caseId = await seedCase(app, "D-RESTART");
    // 到期时间固定在“未来 10 秒”
    const dueIso = new Date(Date.now() + 10_000).toISOString();
    await json(app, { method: "PUT", url: `/cases/${caseId}/deadline`, headers: ACTORS.liaison, body: { due_at: dueIso } });

    await json(app, { method: "POST", url: `/cases/${caseId}/ingest`, headers: ACTORS.liaison, body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("1"), source_summary: { batch: "b" } } });
    const variant = await json(app, { method: "POST", url: `/cases/${caseId}/ingest`, headers: ACTORS.liaison, body: { source_key: "email", source_native_id: "ATT-1001", content: evidenceContent("2"), source_summary: { batch: "b2" } } });
    await json(app, { method: "POST", url: `/cases/${caseId}/ingest`, headers: ACTORS.liaison, body: { source_key: "hotline", source_native_id: "CALL-2002", content: evidenceContent("3"), source_summary: { batch: "b" } } });
    await json(app, { method: "POST", url: `/cases/${caseId}/ingest`, headers: ACTORS.liaison, body: { source_key: "merchant", source_native_id: "DOC-3003", content: evidenceContent("4"), source_summary: { batch: "b" } } });
    const freeze = await json(app, { method: "POST", url: `/cases/${caseId}/freeze`, headers: ACTORS.liaison });
    // 未完成（草稿性质）的复核意见同样落库
    await json(app, {
      method: "POST",
      url: `/cases/${caseId}/reviews`,
      headers: ACTORS.reviewer,
      body: { decision: "incomplete", note: "正在核对商家公章，服务中断前未写完…" },
    });

    // 模拟停服：直接在同一数据库上用全新服务实例（重启）
    await h.close();
    const restarted = new EvidenceService(db);

    // 法定时钟未重置：活动时限仍是同一绝对 due_at
    const status = restarted.getCaseStatus(caseId);
    assert.equal(status.deadline.due_at, dueIso);
    assert.equal(status.deadline.overdue, false);

    // 异文版本仍在隔离区，可在重启后继续核查
    const pending = db.prepare("SELECT * FROM evidence_items WHERE case_id = ? AND status = 'quarantined'").all(caseId);
    assert.equal(pending.length, 1);
    const resolved = restarted.resolveQuarantine(
      { id: "reviewer-1", roles: ["reviewer"] },
      pending[0].id,
      "admit",
      variant.body.recordId,
    );
    assert.equal(resolved.decision, "admit");

    // 未完成意见仍在
    const reviews = db.prepare("SELECT note FROM reviews WHERE case_id = ?").all(caseId) as any[];
    assert.equal(reviews.length, 1);
    assert.match(reviews[0].note, /未写完/);

    // 冻结清单未被重启影响
    assert.equal((db.prepare("SELECT manifest_hash FROM frozen_manifests WHERE id = ?").get(freeze.body.manifestId) as any).manifest_hash, freeze.body.manifest_hash);
  } finally {
    await h.close();
  }
});
