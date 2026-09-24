import type { FastifyInstance } from "fastify";
import { DomainError } from "./util.js";
import type { EvidenceService } from "./evidence-service.js";

interface JsonObject {
  [key: string]: unknown;
}

function bodyOf(request: { body: unknown }): JsonObject {
  return (request.body as JsonObject) ?? {};
}

function actorOf(request: { headers: Record<string, unknown>; body: unknown }): string {
  const fromHeader = request.headers["x-actor"];
  const actor = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  if (typeof actor === "string" && actor.trim()) return actor.trim();
  throw new DomainError("VALIDATION", "缺少操作者身份头 x-actor", 401);
}

function base64ToBuffer(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("VALIDATION", `缺少 Base64 字段 ${field}`, 400);
  }
  return Buffer.from(value, "base64");
}

export function registerRoutes(app: FastifyInstance, service: EvidenceService): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      reply.status(400).send({
        error: { code: "VALIDATION", message: (error as Error).message, details: null },
      });
      return;
    }
    request.log.error(error);
    reply.status(500).send({ error: { code: "INTERNAL", message: "内部错误", details: null } });
  });

  // -- 案件 --------------------------------------------------------------

  app.post("/cases", async (request) => {
    const b = bodyOf(request);
    return service.createCase({
      disputeScope: b.disputeScope,
      createdBy: actorOf(request),
      deadlineAt: String(b.deadlineAt ?? ""),
    });
  });

  app.get("/cases/:caseId", async (request) => {
    const { caseId } = request.params as { caseId: string };
    return service.getCase(caseId);
  });

  app.get("/cases/:caseId/detail", async (request) => {
    const { caseId } = request.params as { caseId: string };
    return service.getCaseDetail(caseId);
  });

  app.post("/cases/:caseId/deadline-extensions", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    return service.extendDeadline(caseId, {
      newDeadlineAt: String(b.newDeadlineAt ?? ""),
      reason: String(b.reason ?? ""),
      requestedBy: actorOf(request),
    });
  });

  app.post("/cases/:caseId/legal-hold", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    return service.imposeLegalHold(caseId, {
      reason: String(b.reason ?? ""),
      actor: actorOf(request),
    });
  });

  // -- 材料接入 ----------------------------------------------------------

  app.post("/cases/:caseId/materials", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    const submittedBy = actorOf(request); // 先认证，再校验载荷
    return service.ingestMaterial(caseId, {
      externalKey: String(b.externalKey ?? ""),
      sourceType: b.sourceType as
        | "email_attachment"
        | "hotline_transcript"
        | "merchant_supplement",
      content: base64ToBuffer(b.contentBase64, "contentBase64"),
      mediaType: b.mediaType == null ? null : String(b.mediaType),
      sourceSummary: String(b.sourceSummary ?? ""),
      collectedAt: String(b.collectedAt ?? ""),
      receivedBatch: b.receivedBatch == null ? null : String(b.receivedBatch),
      submittedBy,
    });
  });

  app.post("/materials/:versionId/quarantine-resolution", async (request) => {
    const { versionId } = request.params as { versionId: string };
    const b = bodyOf(request);
    const decision = b.decision === "accept" || b.decision === "reject" ? b.decision : null;
    if (!decision) throw new DomainError("VALIDATION", "decision 必须为 accept 或 reject", 400);
    return service.resolveQuarantine(versionId, { decision, actor: actorOf(request) });
  });

  app.post("/cases/:caseId/withdrawals", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    return service.recordWithdrawal(caseId, {
      externalKey: String(b.externalKey ?? ""),
      summary: String(b.summary ?? ""),
      submittedBy: actorOf(request),
    });
  });

  // -- 冻结清单 ----------------------------------------------------------

  app.post("/cases/:caseId/manifest/freeze", async (request) => {
    const { caseId } = request.params as { caseId: string };
    return service.freezeManifest(caseId, actorOf(request));
  });

  app.get("/cases/:caseId/manifest", async (request) => {
    const { caseId } = request.params as { caseId: string };
    return service.getManifest(caseId);
  });

  // -- 复核意见草稿 ------------------------------------------------------

  app.put("/cases/:caseId/review-drafts", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    const stage = b.stage === "business" || b.stage === "privacy" ? b.stage : null;
    if (!stage) throw new DomainError("VALIDATION", "stage 必须为 business 或 privacy", 400);
    return service.saveReviewDraft(caseId, {
      stage,
      author: actorOf(request),
      body: String(b.body ?? ""),
    });
  });

  app.get("/cases/:caseId/review-drafts", async (request) => {
    const { caseId } = request.params as { caseId: string };
    return service.listReviewDrafts(caseId);
  });

  // -- 审批与放行 --------------------------------------------------------

  app.post("/cases/:caseId/business-review", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    return service.submitBusinessReview(caseId, {
      reviewer: actorOf(request),
      comment: b.comment == null ? null : String(b.comment),
    });
  });

  app.post("/cases/:caseId/packages", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const b = bodyOf(request);
    const rawRedactions = Array.isArray(b.redactions) ? b.redactions : [];
    const rawMissing = Array.isArray(b.missingItems) ? b.missingItems : [];
    return service.preparePackage(caseId, {
      preparedBy: actorOf(request),
      redactions: rawRedactions.map((entry) => {
        const r = entry as JsonObject;
        return {
          materialId: String(r.materialId ?? ""),
          redactedContent: base64ToBuffer(r.contentBase64, "redactions.contentBase64"),
          changeSummary: r.changeSummary == null ? undefined : String(r.changeSummary),
        };
      }),
      missingItems: rawMissing.map((entry) => {
        const m = entry as JsonObject;
        return { expectedRef: String(m.expectedRef ?? ""), reason: String(m.reason ?? "") };
      }),
    });
  });

  app.post("/packages/:packageId/privacy-approval", async (request) => {
    const { packageId } = request.params as { packageId: string };
    const b = bodyOf(request);
    return service.approvePrivacy(packageId, {
      officer: actorOf(request),
      comment: b.comment == null ? null : String(b.comment),
    });
  });

  app.post("/packages/:packageId/release", async (request) => {
    const { packageId } = request.params as { packageId: string };
    return service.releasePackage(packageId, actorOf(request));
  });

  // -- 授权下载 ----------------------------------------------------------

  app.post("/packages/:packageId/download-links", async (request) => {
    const { packageId } = request.params as { packageId: string };
    const b = bodyOf(request);
    return service.issueDownloadLink(packageId, {
      issuedBy: actorOf(request),
      expiresAt: b.expiresAt == null ? null : String(b.expiresAt),
    });
  });

  app.post("/packages/:packageId/revoke", async (request) => {
    const { packageId } = request.params as { packageId: string };
    const b = bodyOf(request);
    return service.revokeDownloadLinks(packageId, {
      actor: actorOf(request),
      linkId: b.linkId == null ? null : String(b.linkId),
    });
  });

  app.get("/downloads/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const bundle = await service.downloadByToken(token, actorOf(request));
    const encoded = {
      ...bundle,
      files: bundle.files.map((f) => ({
        ...f,
        deliveredContent: f.deliveredContent.toString("base64"),
      })),
    };
    reply.type("application/json");
    return encoded;
  });

  // -- 审计与清理 --------------------------------------------------------

  app.get("/packages/:packageId/audit", async (request) => {
    const { packageId } = request.params as { packageId: string };
    const audit = await service.auditPackage(packageId, actorOf(request));
    return {
      ...audit,
      items: audit.items.map((i) => ({
        ...i,
        original: { ...i.original, content: i.original.content.toString("base64") },
        redaction: i.redaction
          ? { ...i.redaction, content: i.redaction.content.toString("base64") }
          : null,
      })),
    };
  });

  app.post("/admin/cleanup", async (request) => {
    const b = bodyOf(request);
    return service.runCleanup({
      actor: actorOf(request),
      olderThan: String(b.olderThan ?? ""),
    });
  });
}
