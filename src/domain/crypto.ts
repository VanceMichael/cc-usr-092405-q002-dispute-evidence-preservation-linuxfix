import { createHash, randomBytes, randomUUID } from "node:crypto";

/** 服务端 UTC 墙钟。可注入替换以便测试；生产始终取真实当前时间。 */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function nowIso(clock: Clock = systemClock): string {
  return clock().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function newDownloadToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 对 JSON 结构做确定性序列化（键排序、Buffer 取 hex），
 * 供清单摘要 / 交付包摘要在任何进程上复算一致。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("hex"));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function parseJsonArray(value: string | null | undefined, fallback = "[]"): unknown[] {
  try {
    const parsed = JSON.parse(value ?? fallback);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
