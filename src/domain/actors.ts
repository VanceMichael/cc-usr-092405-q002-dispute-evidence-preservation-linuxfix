/**
 * 调用身份。真实部署中由上游认证网关注入；本服务以请求头
 * x-actor-id / x-actor-roles 表达，所有管控动作据此做角色与回避校验。
 */
export type Role =
  | "liaison" // 联络员：建案、采集、冻结、追加关联事实
  | "reviewer" // 业务复核人：异文核查、清单完整性复核
  | "privacy_officer" // 隐私专员：批准字段遮盖
  | "releaser" // 放行人：出具交付包、签发 / 收回下载授权
  | "admin"; // 管理：法律保全、常规清理

export interface Actor {
  id: string;
  roles: Role[];
}

export function hasRole(actor: Actor, ...roles: Role[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}
