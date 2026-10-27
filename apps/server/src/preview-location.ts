/** 注册预览位置相关接口。 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { textFileEncodings } from '../../../packages/contracts/src/files.js';
import type { PreviewService } from './preview.js';

const querySchema = z.object({
  path: z.string().min(1).max(1000),
  anchor: z.string().min(1).max(768),
  encoding: z.enum(textFileEncodings).default('auto'),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  cursor: z
    .string()
    .regex(/^[a-f0-9]{48}$/)
    .optional(),
});
export function registerPreviewLocationRoutes(app: FastifyInstance, previews: PreviewService) {
  app.get<{ Params: { runId: string; taskId: string }; Querystring: { path: string } }>(
    '/api/runs/:runId/tasks/:taskId/preview/entry',
    async (request, reply) => {
      const { path } = z
        .object({ path: z.string().min(1).max(1000) })
        .strict()
        .parse(request.query);
      const controller = new AbortController(),
        abort = () => controller.abort();
      const disconnect = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', disconnect);
      reply.header('Cache-Control', 'no-store');
      try {
        return await previews.entry(request.params.runId, request.params.taskId, path, controller.signal);
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', disconnect);
      }
    },
  );
  app.get<{
    Params: { runId: string; taskId: string };
    Querystring: { path: string; anchor: string; encoding?: string; version?: string; cursor?: string };
  }>('/api/runs/:runId/tasks/:taskId/preview/locate', async (request, reply) => {
    const { path, ...options } = querySchema.parse(request.query);
    const controller = new AbortController(),
      abort = () => controller.abort();
    const disconnect = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', disconnect);
    reply.header('Cache-Control', 'no-store');
    try {
      return await previews.locate(request.params.runId, request.params.taskId, path, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', disconnect);
    }
  });
}
