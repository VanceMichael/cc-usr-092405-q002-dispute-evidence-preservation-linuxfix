import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let current = Date.parse("2026-09-24T00:00:00.000Z");
let app: FastifyInstance;

test.beforeEach(() => {
  current = Date.parse("2026-09-24T00:00:00.000Z");
  process.env.DATABASE_PATH = join(
    mkdtempSync(join(tmpdir(), "dispute-http-")),
    "service.sqlite3",
  );
  app = buildApp({ clock: () => new Date(current) });
});

test.afterEach(async () => {
  await app.close();
  delete process.env.DATABASE_PATH;
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function call(
  method: string,
  url: string,
  opts: { actor?: string; body?: unknown } = {},
) {
  return app.inject({
    method,
    url,
    payload: opts.body as never,
    headers: opts.actor ? { "x-actor": opts.actor } : {},
  });
}

test("HTTP 全链路：建案→接入→异文隔离→冻结→复核→遮盖批准→放行→下载→撤销", async () => {
  // 建案
  let res = await call("POST", "/cases", {
    actor: "liaison.chen",
    body: {
      disputeScope: { batches: ["B-37", "B-38"] },
      deadlineAt: "2026-09-26T00:00:00.000Z",
    },
  });
  assert.equal(res.statusCode, 200);
  const caseId = res.json().id;

  // 缺 x-actor 被拒（机器可读错误）
  res = await call("POST", `/cases/${caseId}/materials`, {
    body: { externalKey: "M1" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "VALIDATION");

  // 接入两份
  res = await call("POST", `/cases/${caseId}/materials`, {
    actor: "liaison.chen",
    body: {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      contentBase64: b64("发票 13800000001"),
      sourceSummary: "邮件发票",
      collectedAt: "2026-09-23T10:00:00.000Z",
      receivedBatch: "B-37",
    },
  });
  assert.equal(res.statusCode, 200);
  const mail = res.json();
  res = await call("POST", `/cases/${caseId}/materials`, {
    actor: "clerk.wang",
    body: {
      externalKey: "CALL-9",
      sourceType: "hotline_transcript",
      contentBase64: b64("热线转写"),
      sourceSummary: "热线转写",
      collectedAt: "2026-09-23T12:00:00.000Z",
      receivedBatch: "B-38",
    },
  });
  assert.equal(res.statusCode, 200);

  // 同内容重送 -> 去重
  res = await call("POST", `/cases/${caseId}/materials`, {
    actor: "clerk.wang",
    body: {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      contentBase64: b64("发票 13800000001"),
      sourceSummary: "另一批次重发",
      collectedAt: "2026-09-23T18:00:00.000Z",
      receivedBatch: "B-39",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deduplicated, true);
  assert.equal(res.json().versionId, mail.versionId);

  // 异文 -> 422 隔离
  res = await call("POST", `/cases/${caseId}/materials`, {
    actor: "clerk.wang",
    body: {
      externalKey: "MAIL-1",
      sourceType: "email_attachment",
      contentBase64: b64("被撤回材料替换的异文"),
      sourceSummary: "异文",
      collectedAt: "2026-09-23T20:00:00.000Z",
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "QUARANTINED_VARIANT");
  const quarantinedVersionId = res.json().error.details.versionId;

  // 核查异文：驳回（保持原始版本）
  res = await call("POST", `/materials/${quarantinedVersionId}/quarantine-resolution`, {
    actor: "liaison.chen",
    body: { decision: "reject" },
  });
  assert.equal(res.statusCode, 200);

  // 冻结
  res = await call("POST", `/cases/${caseId}/manifest/freeze`, { actor: "liaison.chen" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().itemCount, 2);

  // 自我审批拦截
  res = await call("POST", `/cases/${caseId}/business-review`, {
    actor: "liaison.chen",
    body: { comment: "我自己提交的我来批" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "SELF_APPROVAL_FORBIDDEN");

  // 合法复核
  res = await call("POST", `/cases/${caseId}/business-review`, {
    actor: "reviewer.li",
    body: { comment: "完整" },
  });
  assert.equal(res.statusCode, 200);

  // 制备遮盖包
  res = await call("POST", `/cases/${caseId}/packages`, {
    actor: "liaison.chen",
    body: {
      redactions: [
        {
          materialId: mail.materialId,
          contentBase64: b64("发票 ***********"),
          changeSummary: "遮盖手机号",
        },
      ],
      missingItems: [{ expectedRef: "SUP-9", reason: "商家未交" }],
    },
  });
  assert.equal(res.statusCode, 200);
  const packageId = res.json().id;

  // 隐私批准：提交人不行
  res = await call("POST", `/packages/${packageId}/privacy-approval`, {
    actor: "liaison.chen",
  });
  assert.equal(res.statusCode, 403);
  res = await call("POST", `/packages/${packageId}/privacy-approval`, {
    actor: "privacy.zhou",
    body: { comment: "遮盖到位" },
  });
  assert.equal(res.statusCode, 200);

  // 放行
  res = await call("POST", `/packages/${packageId}/release`, { actor: "legal.hao" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().released_by, "legal.hao");

  // 签发下载地址并下载
  res = await call("POST", `/packages/${packageId}/download-links`, { actor: "legal.hao" });
  assert.equal(res.statusCode, 200);
  const token = res.json().token;

  res = await call("GET", `/downloads/${token}`, { actor: "regulator.x" });
  assert.equal(res.statusCode, 200);
  const bundle = res.json();
  const deliveredMail = bundle.files.find((f: { externalKey: string }) => f.externalKey === "MAIL-1");
  assert.equal(deliveredMail.redacted, true);
  assert.equal(Buffer.from(deliveredMail.deliveredContent, "base64").toString("utf8"), "发票 ***********");
  assert.deepEqual(bundle.missingItems, [{ expectedRef: "SUP-9", reason: "商家未交" }]);

  // 抽查审计
  res = await call("GET", `/packages/${packageId}/audit`, { actor: "auditor.sun" });
  assert.equal(res.statusCode, 200);
  const audit = res.json();
  assert.equal(audit.package.digestMatches, true);
  assert.equal(audit.package.releasedBy, "legal.hao");
  assert.equal(
    Buffer.from(
      audit.items.find((i: { externalKey: string }) => i.externalKey === "MAIL-1").original
        .content,
      "base64",
    ).toString("utf8"),
    "发票 13800000001",
  );

  // 撤销后旧地址立即失效
  res = await call("POST", `/packages/${packageId}/revoke`, { actor: "legal.hao" });
  assert.equal(res.statusCode, 200);
  res = await call("GET", `/downloads/${token}`, { actor: "regulator.x" });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error.code, "LINK_REVOKED");
});

test("法律保全 + 续期 + 清理豁免的 HTTP 流程", async () => {
  let res = await call("POST", "/cases", {
    actor: "liaison.chen",
    body: { disputeScope: {}, deadlineAt: "2026-09-26T00:00:00.000Z" },
  });
  const caseId = res.json().id;

  // 续期缺理由
  res = await call("POST", `/cases/${caseId}/deadline-extensions`, {
    actor: "liaison.chen",
    body: { newDeadlineAt: "2026-09-30T00:00:00.000Z", reason: "" },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "REASON_REQUIRED");

  res = await call("POST", `/cases/${caseId}/deadline-extensions`, {
    actor: "liaison.chen",
    body: { newDeadlineAt: "2026-09-30T00:00:00.000Z", reason: "等待补件批次" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deadline_at, "2026-09-30T00:00:00.000Z");

  res = await call("POST", `/cases/${caseId}/legal-hold`, {
    actor: "liaison.chen",
    body: { reason: "监管询证未结" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().legal_hold, 1);

  res = await call("POST", "/admin/cleanup", {
    actor: "system.cleanup",
    body: { olderThan: "2026-10-01T00:00:00.000Z" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().skipped_hold_count, 1);
  assert.equal(res.json().deleted_count, 0);
});
