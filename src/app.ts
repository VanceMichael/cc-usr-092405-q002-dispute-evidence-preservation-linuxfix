import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { openRawDatabase } from "./database.js";
import type Database from "better-sqlite3";
import type { Actor, Role } from "./domain/actors.js";
import { DomainError, Errors } from "./domain/errors.js";
import { EvidenceService } from "./domain/service.js";

/** 错误代码 → HTTP 状态映射；错误代码本身保持稳定，供调用方程序化处理。 */
const STATUS_BY_CODE: Record<string, number> = {
  ACTOR_REQUIRED: 401,
  FORBIDDEN_ROLE: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  DOWNLOAD_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  DEADLINE_EXTENSION_REASON_REQUIRED: 422,
  CASE_NOT_OPEN: 409,
  FROZEN_APPEND_ONLY: 409,
  MANIFEST_NOT_FROZEN: 409,
  MANIFEST_ALREADY_FROZEN: 409,
  QUARANTINED_VARIANT_PENDING: 409,
  REVIEW_INCOMPLETE: 409,
  REDACTION_NOT_APPROVED: 409,
  REDACTION_VERSION_MISMATCH: 409,
  ACTIVE_LEGAL_HOLD: 409,
  PACKAGE_INTEGRITY_FAILED: 500,
};

export interface AppOptions {
  db?: Database.Database;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const ownsDb = !options.db;
  const db = options.db ?? openRawDatabase();
  const service = new EvidenceService(db);

  app.addHook("onClose", async () => {
    if (ownsDb) db.close();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DomainError) {
      const domainError: DomainError = error;
      void reply.status(STATUS_BY_CODE[domainError.code] ?? 400).send({
        error: { code: domainError.code, message: domainError.message, details: domainError.details ?? {} },
      });
      return;
    }
    // Fastify 自身的解析 / 校验错误（statusCode 4xx）原样透传为稳定负载
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error(error);
    void reply.status(status).send({
      error: { code: error.code ?? "INTERNAL", message: status === 500 ? "内部错误" : error.message },
    });
  });

  function actorFrom(request: import("fastify").FastifyRequest): Actor {
    const id = request.headers["x-actor-id"];
    if (typeof id !== "string" || !id.trim()) throw Errors.actorRequired();
    const rolesHeader = request.headers["x-actor-roles"];
    const roles = (typeof rolesHeader === "string" ? rolesHeader : "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean) as Role[];
    return { id, roles };
  }

  app.get("/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  // ── 建案与法定时钟 ────────────────────────────────────────────────────
  app.post("/cases", async (request, reply) => {
    const actor = actorFrom(request);
    const body = request.body as { case_no: string; title: string; scope: any; retention_until?: string };
    const result = service.createCase(actor, body);
    return reply.status(201).send(result);
  });

  app.get<{ Params: { caseId: string } }>("/cases/:caseId", async (request) => {
    actorFrom(request);
    return service.getCaseStatus(request.params.caseId);
  });

  app.put<{ Params: { caseId: string } }>("/cases/:caseId/deadline", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as { due_at: string; reason?: string };
    return service.setDeadline(actor, request.params.caseId, body);
  });

  // ── 接入采集 / 异文核查 ───────────────────────────────────────────────
  app.post<{ Params: { caseId: string } }>("/cases/:caseId/ingest", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as any;
    return service.ingest(actor, request.params.caseId, body);
  });

  app.post<{ Params: { itemId: string } }>("/items/:itemId/quarantine-resolution", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as { decision: "admit" | "reject"; record_id?: string };
    return service.resolveQuarantine(actor, request.params.itemId, body.decision, body.record_id);
  });

  // ── 冻结 / 追加关联事实 ───────────────────────────────────────────────
  app.post<{ Params: { caseId: string } }>("/cases/:caseId/freeze", async (request) => {
    const actor = actorFrom(request);
    return service.freezeManifest(actor, request.params.caseId);
  });

  app.post<{ Params: { caseId: string } }>("/cases/:caseId/linked-facts", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as any;
    return service.appendLinkedFact(actor, request.params.caseId, body);
  });

  // ── 复核 / 遮盖 / 放行 ────────────────────────────────────────────────
  app.post<{ Params: { caseId: string } }>("/cases/:caseId/reviews", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as { decision: "complete" | "incomplete"; note?: string };
    return service.submitReview(actor, request.params.caseId, body);
  });

  app.post<{ Params: { caseId: string } }>("/cases/:caseId/redactions", async (request) => {
    const actor = actorFrom(request);
    const body = request.body as { rules: any[] };
    return service.approveRedaction(actor, request.params.caseId, body.rules ?? []);
  });

  app.post<{ Params: { caseId: string } }>("/cases/:caseId/packages", async (request, reply) => {
    const actor = actorFrom(request);
    const result = service.releasePackage(actor, request.params.caseId);
    return reply.status(201).send(result);
  });

  // ── 下载授权 ──────────────────────────────────────────────────────────
  app.post<{ Params: { packageId: string } }>("/packages/:packageId/grants", async (request, reply) => {
    const actor = actorFrom(request);
    const body = (request.body ?? {}) as { ttl_seconds?: number };
    const result = service.issueGrant(actor, request.params.packageId, body.ttl_seconds);
    return reply.status(201).send(result);
  });

  app.post<{ Params: { grantId: string } }>("/grants/:grantId/revoke", async (request) => {
    const actor = actorFrom(request);
    return service.revokeGrant(actor, request.params.grantId);
  });

  // 下载仍需调用身份，以便对“谁在什么时间取走包”留痕
  app.get<{ Params: { token: string } }>("/downloads/:token", async (request) => {
    const actor = actorFrom(request);
    return service.downloadByToken(actor.id, request.params.token);
  });

  // ── 法律保全 / 清理 ───────────────────────────────────────────────────
  app.post<{ Params: { caseId: string } }>("/cases/:caseId/legal-holds", async (request, reply) => {
    const actor = actorFrom(request);
    const body = request.body as { reason: string };
    const result = service.placeLegalHold(actor, request.params.caseId, body.reason);
    return reply.status(201).send(result);
  });

  app.post<{ Params: { holdId: string } }>("/legal-holds/:holdId/release", async (request) => {
    const actor = actorFrom(request);
    return service.releaseLegalHold(actor, request.params.holdId);
  });

  app.post("/admin/cleanup", async (request) => {
    const actor = actorFrom(request);
    return service.runCleanup(actor);
  });

  // ── 审计 ──────────────────────────────────────────────────────────────
  app.get<{ Params: { packageId: string } }>("/packages/:packageId/audit", async (request) => {
    const actor = actorFrom(request);
    return service.auditPackage(actor, request.params.packageId);
  });

  app.get<{ Params: { caseId: string } }>("/cases/:caseId/access-logs", async (request) => {
    const actor = actorFrom(request);
    return { logs: service.listAccessLogs(actor, request.params.caseId) };
  });

  return app;
}
