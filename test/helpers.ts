import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { openRawDatabase, type EvidenceDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrate.js";
import { EvidenceService } from "../src/domain/evidence-service.js";

export interface Harness {
  dbPath: string;
  db: EvidenceDatabase;
  service: EvidenceService;
  setNow: (iso: string) => void;
  advance: (ms: number) => void;
  close: () => void;
}

/** 临时库 + 已迁移 + 可控时钟。 */
export function createHarness(startIso = "2026-09-24T00:00:00.000Z"): Harness {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), "dispute-evidence-")),
    "service.sqlite3",
  );
  process.env.DATABASE_PATH = dbPath;
  const raw = openRawDatabase();
  applyMigrations(raw);
  const db = new Kysely({ dialect: new SqliteDialect({ database: raw }) });

  let current = Date.parse(startIso);
  const clock = () => new Date(current);
  const service = new EvidenceService(db, clock);

  return {
    dbPath,
    db,
    service,
    setNow: (iso: string) => {
      current = Date.parse(iso);
    },
    advance: (ms: number) => {
      current += ms;
    },
    close: () => {
      void db.destroy();
      delete process.env.DATABASE_PATH;
    },
  };
}

/** 用同一文件重新打开（模拟停服重启）：数据、绝对时限、草稿均应保留。 */
export function reopenHarness(dbPath: string, currentIso: string): Harness {
  process.env.DATABASE_PATH = dbPath;
  const raw = openRawDatabase();
  applyMigrations(raw); // 幂等
  const db = new Kysely({ dialect: new SqliteDialect({ database: raw }) });
  let current = Date.parse(currentIso);
  const service = new EvidenceService(db, () => new Date(current));
  return {
    dbPath,
    db,
    service,
    setNow: (iso: string) => {
      current = Date.parse(iso);
    },
    advance: (ms: number) => {
      current += ms;
    },
    close: () => {
      void db.destroy();
      delete process.env.DATABASE_PATH;
    },
  };
}

export const ACTORS = {
  liaison: "liaison.chen",
  reviewer: "reviewer.li",
  privacy: "privacy.zhou",
  releaser: "legal.hao",
  submitter: "liaison.chen",
  otherSubmitter: "clerk.wang",
  cleaner: "system.cleanup",
};

export function text(content: string): Buffer {
  return Buffer.from(content, "utf8");
}

export function maskPii(content: Buffer): Buffer {
  return Buffer.from(content.toString("utf8").replace(/1[3-9]\d{9}/g, "***********"), "utf8");
}

/** 建案 + 两份材料 + 冻结的标准案件。 */
export async function seedFrozenCase(h: Harness) {
  const deadline = "2026-09-26T00:00:00.000Z";
  const kase = await h.service.createCase({
    disputeScope: { batches: ["B-2026-37", "B-2026-38"], merchant: "M-77" },
    createdBy: ACTORS.liaison,
    deadlineAt: deadline,
  });
  const a = await h.service.ingestMaterial(kase.id, {
    externalKey: "MAIL-1",
    sourceType: "email_attachment",
    content: text("发票与沟通记录 13800000001"),
    sourceSummary: "消费者邮件附件：发票",
    collectedAt: "2026-09-23T10:00:00.000Z",
    receivedBatch: "B-2026-37",
    submittedBy: ACTORS.submitter,
  });
  const b = await h.service.ingestMaterial(kase.id, {
    externalKey: "CALL-9",
    sourceType: "hotline_transcript",
    content: text("热线转写全文"),
    sourceSummary: "12345 号工单热线转写",
    collectedAt: "2026-09-23T12:00:00.000Z",
    receivedBatch: "B-2026-38",
    submittedBy: ACTORS.otherSubmitter,
  });
  const frozen = await h.service.freezeManifest(kase.id, ACTORS.liaison);
  return { caseId: kase.id, deadline, materials: { a, b }, manifestId: frozen.manifestId };
}
