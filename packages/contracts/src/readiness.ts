// 应用准备状态及可执行引导操作的契约。
import { z } from 'zod';

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

// 每项检查携带独立状态和可选操作，不由此自动认定系统整体就绪。
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

/** Configuration evidence only. No aggregate "ready" claim or live credential result. */
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
