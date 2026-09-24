import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

/** 稳定机器可读错误代码（docs/domain.md 中登记）。 */
export type ErrorCode =
  | "CASE_NOT_FOUND"
  | "MANIFEST_NOT_FOUND"
  | "PACKAGE_NOT_FOUND"
  | "MATERIAL_NOT_FOUND"
  | "DEADLINE_PASSED"
  | "DEADLINE_NOT_LATER"
  | "REASON_REQUIRED"
  | "NOT_FROZEN"
  | "ALREADY_FROZEN"
  | "QUARANTINED_VARIANT"
  | "BUSINESS_REVIEW_REQUIRED"
  | "PRIVACY_APPROVAL_REQUIRED"
  | "APPROVAL_VERSION_MISMATCH"
  | "SELF_APPROVAL_FORBIDDEN"
  | "ALREADY_REVIEWED"
  | "NOTHING_TO_RELEASE"
  | "LINK_INVALID"
  | "LINK_REVOKED"
  | "LINK_EXPIRED"
  | "LEGAL_HOLD_CONFLICT"
  | "VALIDATION";

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256Buffer(content: Buffer | string): Buffer {
  return createHash("sha256").update(content).digest();
}

/** 规范 JSON：键排序、无空白，保证跨进程摘要稳定。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function canonicalDigest(value: unknown): string {
  return sha256(canonicalize(value));
}

export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export function isPast(iso: string, clock: () => Date): boolean {
  return Date.parse(iso) <= clock().getTime();
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
