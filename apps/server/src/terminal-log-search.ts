import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  invariant,
  type Artifact,
  type Operation,
  type Run,
  type Task,
} from '../../../packages/contracts/src/index.js';
import type { TerminalLogMatch, TerminalLogSearchPage } from '../../../packages/contracts/src/log-search.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { ArtifactPreviewService } from './artifact-preview.js';

const scanBytes = 8 * 1024 * 1024;
const contextBytes = 180;
const searchQuery = z.object({
  artifactId: z.string().uuid(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), '关键词不能包含控制字符'),
  cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(30).default(20),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const edgeText = (bytes: Buffer) => bytes.toString('utf8').replace(/^\uFFFD+|\uFFFD+$/g, '');

export function registerTerminalLogSearchRoutes(
  app: FastifyInstance,
  store: Store,
  previews: ArtifactPreviewService,
) {
  app.get<{
    Params: { runId: string; taskId: string };
    Querystring: { artifactId: string; q: string; cursor?: string; limit?: string; version?: string };
  }>(
    '/api/runs/:runId/tasks/:taskId/terminal-log/search',
    async (request, reply): Promise<TerminalLogSearchPage> => {
      const query = searchQuery.parse(request.query);
      const run = store.require<Run>('runs', request.params.runId);
      const task = store.require<Task>('tasks', request.params.taskId);
      invariant(task.runId === run.id, 'TERMINAL_LOG_TASK', '代理不属于当前任务');
      invariant(run.contract.permissionProfile.read, 'TERMINAL_LOG_DENIED', '当前任务未授权读取日志');
      const artifact = store.require<Artifact>('artifacts', query.artifactId);
      invariant(
        artifact.runId === run.id && artifact.taskId === task.id,
        'TERMINAL_LOG_ARTIFACT',
        '日志不属于当前代理',
      );
      const publicTranscript = store
        .all<Operation>('tool_operations', run.id)
        .some(
          (operation) =>
            operation.taskId === task.id &&
            operation.name === 'terminal_agent' &&
            operation.result &&
            typeof operation.result === 'object' &&
            (operation.result as { transcriptArtifactId?: unknown }).transcriptArtifactId === artifact.id,
        );
      invariant(
        publicTranscript &&
          artifact.name === 'agent-terminal.txt' &&
          artifact.mediaType.split(';')[0] === 'text/plain',
        'TERMINAL_LOG_ARTIFACT',
        '仅支持搜索已交付的公开终端日志',
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      const disconnected = () => {
        if (!reply.raw.writableEnded) abort();
      };
      reply.raw.once('close', disconnected);
      reply.header('Cache-Control', 'no-store');
      let resource: Awaited<ReturnType<ArtifactPreviewService['resource']>> | undefined;
      const needle = Buffer.from(query.q, 'utf8');
      const matches: TerminalLogMatch[] = [];
      let carry = Buffer.alloc(0),
        consumed = 0,
        scannedUntil = query.cursor,
        nextCursor: number | null = null;
      let cursor = query.cursor;
      try {
        resource = await previews.resource(artifact, { signal: controller.signal });
        const scanEnd = Math.min(resource.size, query.cursor + scanBytes);
        if (query.version && query.version !== resource.version)
          throw new AppError('FILE_CHANGED', '日志已变化，请重新搜索。', false, null, 409);
        invariant(query.cursor <= resource.size, 'TERMINAL_LOG_CURSOR', '搜索位置超出日志');
        // Buffer only one stream chunk plus the small overlap; never materialize the full log.
        for await (const raw of resource.stream) {
          controller.signal.throwIfAborted();
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          const start = consumed - carry.length;
          const bytes = Buffer.concat([carry, chunk]);
          consumed += chunk.length;
          const eof = consumed >= resource.size;
          const safeEnd = Math.min(scanEnd, eof ? consumed : consumed - needle.length + 1);
          let index = bytes.indexOf(needle, Math.max(0, cursor - start));
          while (index >= 0 && start + index < safeEnd) {
            const offset = start + index;
            matches.push({
              offset,
              endOffset: offset + needle.length,
              before: edgeText(bytes.subarray(Math.max(0, index - contextBytes), index)),
              match: query.q,
              after: edgeText(bytes.subarray(index + needle.length, index + needle.length + contextBytes)),
            });
            cursor = offset + 1;
            if (matches.length >= query.limit) {
              nextCursor = cursor < resource.size ? cursor : null;
              scannedUntil = cursor;
              break;
            }
            index = bytes.indexOf(needle, cursor - start);
          }
          if (matches.length >= query.limit) break;
          cursor = Math.max(cursor, safeEnd);
          scannedUntil = cursor;
          if (cursor >= scanEnd) {
            nextCursor = cursor < resource.size ? cursor : null;
            break;
          }
          carry = bytes.subarray(Math.max(0, bytes.length - Math.max(needle.length - 1, contextBytes)));
        }
        resource.stream.destroy();
        // Revalidate after a partial scan, including disk replacements during the request.
        await previews.preview(artifact, 'utf-8', {
          limit: 1,
          version: resource.version,
          signal: controller.signal,
        });
        return {
          artifactId: artifact.id,
          query: query.q,
          version: resource.version,
          totalBytes: resource.size,
          scannedUntil,
          nextCursor,
          matches,
        };
      } finally {
        resource?.stream.destroy();
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', disconnected);
      }
    },
  );
}
