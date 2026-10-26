import { z } from 'zod';

export const ToolReviewPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('rules') }).strict(),
  z.object({ mode: z.literal('model'), providerId: z.string().min(1) }).strict(),
]);
export type ToolReviewPolicy = z.infer<typeof ToolReviewPolicy>;

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

export const ToolReviewDecision = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type ToolReviewDecision = z.infer<typeof ToolReviewDecision>;
export interface ToolReviewReceipt extends ToolReviewDecision {
  fingerprint: string;
  mode: 'rules' | 'model';
  reviewedAt: string;
  requestId?: string;
}
