/** 稳定的机器可读错误代码，接口层据此映射 HTTP 状态。 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const Errors = {
  actorRequired: () => new DomainError("ACTOR_REQUIRED", "缺少 x-actor-id 调用身份"),
  forbiddenRole: (needed: string[]) =>
    new DomainError("FORBIDDEN_ROLE", `需要角色：${needed.join(" / ")}`, { needed }),
  notFound: (resource: string) => new DomainError("NOT_FOUND", `${resource} 不存在`, { resource }),
  validation: (message: string, details?: Record<string, unknown>) =>
    new DomainError("VALIDATION_ERROR", message, details),

  caseNotOpen: () => new DomainError("CASE_NOT_OPEN", "案件未处于可采集状态"),
  caseNotFrozen: () => new DomainError("MANIFEST_NOT_FROZEN", "清单尚未冻结"),
  manifestAlreadyFrozen: () =>
    new DomainError("MANIFEST_ALREADY_FROZEN", "清单已冻结，冻结版本不可变"),
  itemQuarantined: (itemId: string) =>
    new DomainError("QUARANTINED_VARIANT_PENDING", "同一标识出现异文，材料已隔离待核查", { itemId }),

  linkedFactKindRequired: () =>
    new DomainError("VALIDATION_ERROR", "冻结后的更正 / 撤回 / 补件必须指明 kind"),
  extensionReasonRequired: () =>
    new DomainError("DEADLINE_EXTENSION_REASON_REQUIRED", "法定时限续期必须附带理由"),

  reviewIncomplete: () =>
    new DomainError("REVIEW_INCOMPLETE", "最近一次业务复核结论为不完整，不能放行"),
  redactionMissing: () =>
    new DomainError("REDACTION_NOT_APPROVED", "隐私专员尚未批准遮盖方案"),
  redactionVersionMismatch: () =>
    new DomainError("REDACTION_VERSION_MISMATCH", "遮盖方案必须基于当前冻结清单版本"),
  selfApproval: () =>
    new DomainError("SELF_APPROVAL_FORBIDDEN", "任何人都不能审批自己提交的材料"),

  grantRevoked: () => new DomainError("DOWNLOAD_DENIED", "下载授权已收回"),
  grantExpired: () => new DomainError("DOWNLOAD_DENIED", "下载授权已过期"),
  grantInvalid: () => new DomainError("DOWNLOAD_DENIED", "下载地址无效"),

  activeLegalHold: (caseId: string) =>
    new DomainError("ACTIVE_LEGAL_HOLD", "法律保全生效中，常规清理不得触碰", { caseId }),
} satisfies Record<string, (...args: any[]) => DomainError>;
