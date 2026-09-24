import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Harness {
  db: Database.Database;
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** 每个用例独立的临时库文件，完整执行迁移。 */
export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "evidence-store-"));
  const db = new Database(join(dir, "service.sqlite3"));
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(join(projectRoot, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(projectRoot, "migrations", file), "utf8"));
  }
  const app = buildApp({ db });
  return { db, app, close: () => app.close() };
}

export const ACTORS = {
  liaison: { "x-actor-id": "liaison-1", "x-actor-roles": "liaison" },
  liaison2: { "x-actor-id": "liaison-2", "x-actor-roles": "liaison" },
  // 同一人兼有采集与审批角色，用于验证回避规则看人不看角色
  samePerson: { "x-actor-id": "liaison-1", "x-actor-roles": "reviewer,privacy_officer,releaser" },
  reviewer: { "x-actor-id": "reviewer-1", "x-actor-roles": "reviewer" },
  privacy: { "x-actor-id": "privacy-1", "x-actor-roles": "privacy_officer" },
  releaser: { "x-actor-id": "releaser-1", "x-actor-roles": "releaser" },
  admin: { "x-actor-id": "admin-1", "x-actor-roles": "admin" },
} as const;

export async function json(
  app: FastifyInstance,
  options: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
) {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: options.body === undefined ? options.headers : { "content-type": "application/json", ...options.headers },
    payload: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.statusCode, body: response.json() as any };
}

/** 标准争议范围：邮件附件 + 热线转写 + 商家补件各一，另留一个永远缺失的期望项。 */
export const SCOPE = {
  description: "2026-09 消费争议批次 48 小时监管询证",
  expected: [
    { source_key: "email", source_native_id: "ATT-1001", title: "订单确认邮件附件" },
    { source_key: "hotline", source_native_id: "CALL-2002", title: "热线转写" },
    { source_key: "merchant", source_native_id: "DOC-3003", title: "商家补件" },
    { source_key: "email", source_native_id: "ATT-1099", title: "尚未采集的退款凭证" },
  ],
};

export function evidenceContent(phone: string, note = "争议材料正文") {
  return JSON.stringify({
    body: note,
    consumer: { name: "王某某", phone },
  });
}
