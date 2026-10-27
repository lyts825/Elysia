/**
 * 工具评审与命令执行后端的共享配置约束。
 * 这里只校验策略和回执形状，授权、指纹重检及命令隔离由执行宿主实现。
 *
 * EN: Defines shared validation for tool-review policy and command execution backends.
 * Validates policy/receipt shapes only; the host enforces permissions, fingerprint rechecks, and command isolation.
 */
import { z } from 'zod';

/**
 * 审核按模式区分：关闭、仅规则或指定审核模型；严格模式拒绝未知字段。
 *
 * EN: Discriminates between disabled, rules-only, and model-backed review; strict schemas reject unknown fields.
 */
export const ToolReviewPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('rules') }).strict(),
  z.object({ mode: z.literal('model'), providerId: z.string().min(1) }).strict(),
]);
export type ToolReviewPolicy = z.infer<typeof ToolReviewPolicy>;

/**
 * exec 的冻结后端；docker 只接受镜像标识，实际执行不会因镜像或引擎不可用回退本机。
 *
 * EN: The frozen backend for exec. Docker accepts only an image identifier and never falls back to the host when the image or engine is unavailable.
 */
export const CommandBackendPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z
    .object({
      kind: z.literal('docker'),
      image: z
        .string()
        .min(1)
        .max(250)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
    })
    .strict(),
]);
export type CommandBackendPolicy = z.infer<typeof CommandBackendPolicy>;

/**
 * 审核只有允许/拒绝和说明，不提供可执行命令或授予新权限。
 *
 * EN: A review provides only an allow/deny decision and explanation; it neither supplies executable commands nor grants new permissions.
 */
export const ToolReviewDecision = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type ToolReviewDecision = z.infer<typeof ToolReviewDecision>;
/**
 * 宿主保存的审核回执，指纹绑定实际参数和执行边界，requestId 关联独立模型审核用量。
 *
 * EN: The host stores a review receipt whose fingerprint binds the actual arguments and execution boundary; requestId links independent model-review usage.
 */
export interface ToolReviewReceipt extends ToolReviewDecision {
  fingerprint: string;
  mode: 'rules' | 'model';
  reviewedAt: string;
  requestId?: string;
}
