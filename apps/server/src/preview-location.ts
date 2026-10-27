/**
 * 注册预览位置相关接口。
 * 将通用定位器接入产物/工作区路由并管理请求取消；路径和文件版本由对应预览服务校验，不扩大原读权限。
 * EN: Registers preview-location endpoints. Connects location to artifact/workspace routes with request cancellation; preview services enforce paths/versions without widening read permission.
 */
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
/**
 * 注册入口和锚点定位查询，路径/编码/版本/续读游标均由服务端 schema 校验。 客户端提前断开时取消当前扫描，finally 卸载监听；定位服务再按任务授权和文件版本核验来源。
 * EN: Registers surface and anchor queries with server schemas for path, encoding, version, and continuation cursor. Early disconnect aborts scans and finally removes listeners; the locator rechecks task authorization and file version.
 */
export function registerPreviewLocationRoutes(app: FastifyInstance, previews: PreviewService) {
  app.get<{ Params: { runId: string; taskId: string }; Querystring: { path: string } }>(
    '/api/runs/:runId/tasks/:taskId/preview/entry',
    async (request, reply) => {
      const { path } = z
        .object({ path: z.string().min(1).max(1000) })
        .strict()
        .parse(request.query);
      const controller = new AbortController(),
        /**
         * 中止当前产物定位的只读扫描。
         * EN: Aborts the current read-only artifact-location scan.
         */
        abort = () => controller.abort();
      /**
       * 产物定位响应提前关闭时取消扫描，已正常写完则保持完成状态。
       * EN: Cancels artifact location on premature response closure while preserving completed sends.
       */
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
      /**
       * 中止当前工作区定位的只读扫描。
       * EN: Aborts the current read-only workspace-location scan.
       */
      abort = () => controller.abort();
    /**
     * 工作区定位响应提前关闭才取消扫描，不影响正常完成的结果。
     * EN: Cancels workspace location only on premature response closure, not normal completion.
     */
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
