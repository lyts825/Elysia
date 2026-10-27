/**
 * 应用准备状态及可执行引导操作的契约。
 * 返回可解释的配置证据和导航建议，不把静态配置完整推断为运行环境已验证。
 *
 * EN: Defines application-readiness evidence and available guidance actions.
 * Returns explainable configuration evidence/navigation without inferring live readiness from complete settings.
 */
import { z } from 'zod';

/**
 * 受限的界面导航建议；读取准备状态不会自动触发模型验证或修改项目配置。
 *
 * EN: Restricted UI navigation suggestions; reading readiness neither validates a model live nor changes project settings.
 */
export const ReadinessAction = z
  .object({
    kind: z.enum([
      'models',
      'new-project',
      'projects',
      'terminal-apps',
      'terminal-connections',
      'terminal-project',
      'terminal-templates',
    ]),
    targetId: z.string().min(1).max(160).optional(),
  })
  .strict();
export type ReadinessAction = z.infer<typeof ReadinessAction>;

/**
 * 每项检查携带独立状态和可选操作，不由此自动认定系统整体就绪。
 *
 * EN: Each check has its own state and optional action; these do not automatically establish overall readiness.
 */
export const ReadinessCheck = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(240),
    status: z.enum(['recorded', 'missing', 'review', 'unknown', 'optional']),
    detail: z.string().min(1).max(2000),
    action: ReadinessAction.optional(),
  })
  .strict();
export type ReadinessCheck = z.infer<typeof ReadinessCheck>;

/**
 * 仅提供配置证据，不作汇总“已就绪”声明，也不包含实时凭据验证结果。
 *
 * EN: Configuration evidence only. No aggregate "ready" claim or live credential result.
 */
export const ReadinessSnapshot = z
  .object({
    version: z.literal(1),
    appVersion: z.string().min(1),
    surface: z.enum(['native', 'terminal']),
    checkedAt: z.string().datetime(),
    projectId: z.string().uuid().nullable(),
    checks: z.array(ReadinessCheck).max(120),
  })
  .strict();
export type ReadinessSnapshot = z.infer<typeof ReadinessSnapshot>;
