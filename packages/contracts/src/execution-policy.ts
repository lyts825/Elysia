// 工具评审与命令执行后端的共享配置约束。
import { z } from 'zod';

// 审核按模式区分：关闭、仅规则或指定审核模型；严格模式拒绝未知字段。
export const ToolReviewPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('rules') }).strict(),
  z.object({ mode: z.literal('model'), providerId: z.string().min(1) }).strict(),
]);
export type ToolReviewPolicy = z.infer<typeof ToolReviewPolicy>;

/** exec 的冻结后端；docker 只接受镜像标识，实际执行不会因镜像或引擎不可用回退本机。 */
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

/** 审核只有允许/拒绝和说明，不提供可执行命令或授予新权限。 */
export const ToolReviewDecision = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type ToolReviewDecision = z.infer<typeof ToolReviewDecision>;
/** 宿主保存的审核回执，指纹绑定实际参数和执行边界，requestId 关联独立模型审核用量。 */
export interface ToolReviewReceipt extends ToolReviewDecision {
  fingerprint: string;
  mode: 'rules' | 'model';
  reviewedAt: string;
  requestId?: string;
}
