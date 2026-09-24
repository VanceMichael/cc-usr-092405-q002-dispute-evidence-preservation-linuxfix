import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/util.js";
import { ACTORS, createHarness } from "./helpers.js";

test("先建立保全案件，再按争议范围冻结材料清单", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: { batches: ["B-37"], disputeIds: ["D-1"] },
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    assert.match(kase.id, /^case_/);
    assert.equal(kase.status, "open");
    assert.equal(kase.frozen_at, null);

    // 冻结前不能走需要清单的流程
    await assert.rejects(
      h.service.recordWithdrawal(kase.id, {
        externalKey: "X",
        summary: "s",
        submittedBy: ACTORS.liaison,
      }),
      (e: DomainError) => e.code === "NOT_FROZEN",
    );
  } finally {
    h.close();
  }
});

test("法定期限可以带理由续期；无理由或未延后被拒绝", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: {},
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });

    await assert.rejects(
      h.service.extendDeadline(kase.id, {
        newDeadlineAt: "2026-09-28T00:00:00.000Z",
        reason: "  ",
        requestedBy: ACTORS.liaison,
      }),
      (e: DomainError) => e.code === "REASON_REQUIRED",
    );

    await assert.rejects(
      h.service.extendDeadline(kase.id, {
        newDeadlineAt: "2026-09-25T00:00:00.000Z",
        reason: "监管口径调整",
        requestedBy: ACTORS.liaison,
      }),
      (e: DomainError) => e.code === "DEADLINE_NOT_LATER",
    );

    const updated = await h.service.extendDeadline(kase.id, {
      newDeadlineAt: "2026-09-28T12:00:00.000Z",
      reason: "商家补件批次延迟，监管已口头同意",
      requestedBy: ACTORS.liaison,
    });
    assert.equal(updated.deadline_at, "2026-09-28T12:00:00.000Z");

    const detail = await h.service.getCaseDetail(kase.id);
    assert.equal(detail.extensions.length, 1);
    assert.match(detail.extensions[0].reason, /商家补件/);
  } finally {
    h.close();
  }
});

test("法律保全生效后，常规清理跳过相关内容并计数留痕", async () => {
  const h = createHarness("2026-09-01T00:00:00.000Z");
  try {
    const held = await h.service.createCase({
      disputeScope: { id: "HELD" },
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-10-01T00:00:00.000Z",
    });
    await h.service.imposeLegalHold(held.id, {
      reason: "监管询证进行中",
      actor: ACTORS.liaison,
    });
    const normal = await h.service.createCase({
      disputeScope: { id: "OLD" },
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-10T00:00:00.000Z",
    });
    // 普通案件走完关闭
    await h.db
      .updateTable("preservation_cases")
      .set({ status: "closed", closed_at: "2026-09-05T00:00:00.000Z" })
      .where("id", "=", normal.id)
      .execute();

    const run = await h.service.runCleanup({
      actor: ACTORS.cleaner,
      olderThan: "2026-09-20T00:00:00.000Z",
    });
    assert.equal(run.deleted_count, 1);
    assert.equal(run.skipped_hold_count, 1);

    // 被保全的案件原封不动
    const stillThere = await h.service.getCase(held.id);
    assert.equal(stillThere.id, held.id);
    await assert.rejects(h.service.getCase(normal.id), (e: DomainError) => e.code === "CASE_NOT_FOUND");

    // 清理留痕
    const logs = await h.db
      .selectFrom("access_logs")
      .selectAll()
      .where("action", "=", "cleanup.run")
      .execute();
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0].detail).skipped_case_ids, [held.id]);
  } finally {
    h.close();
  }
});

test("法律保全必须有理由", async () => {
  const h = createHarness();
  try {
    const kase = await h.service.createCase({
      disputeScope: {},
      createdBy: ACTORS.liaison,
      deadlineAt: "2026-09-26T00:00:00.000Z",
    });
    await assert.rejects(
      h.service.imposeLegalHold(kase.id, { reason: "", actor: ACTORS.liaison }),
      (e: DomainError) => e.code === "REASON_REQUIRED",
    );
  } finally {
    h.close();
  }
});
