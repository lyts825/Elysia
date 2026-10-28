/**
 * 注册本地代理管理接口。
 * 组织概览、扫描、导入及编辑边界并合并内置技能；扫描可取消，持久修改复用版本/幂等规则，解析安全集中于同步服务。
 * EN: Registers local-agent management endpoints. Organizes overview/scan/import/edit boundaries and built-ins with cancellable scans and revisioned idempotent writes; sync services own parsing safety.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Command } from '../../../packages/contracts/src/index.js';
import { Store } from '../../../packages/storage/src/index.js';
import { listSkills } from '../../../packages/context/src/skills.js';
import { readLocalMcpConfig } from '../../../packages/context/src/local-library.js';
import type { ToolGateway } from '../../../packages/tools/src/index.js';
import { LocalAgentSync } from './local-agent-sync.js';

const identifier = z.string().min(1).max(160);
const revision = z.number().int().nonnegative();
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
const configSchema = z
  .object({
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).max(2048).optional(),
    args: z.array(z.string().max(4096)).max(100).optional(),
    cwd: z.string().max(2048).optional(),
    envNames: z.array(envName).max(64),
    url: z.string().url().max(4096).optional(),
    headerEnv: z.record(z.string().min(1).max(128), envName),
    bearerTokenEnv: envName.optional(),
    allowedTools: z.array(z.string().min(1).max(128)).max(500).optional(),
    deniedTools: z.array(z.string().min(1).max(128)).max(500).optional(),
    needsConfiguration: z.boolean(),
  })
  .strict();
/**
 * 将客户端断开传到只读扫描/同步准备；正常响应完成后移除请求监听。
 * EN: Propagates disconnect into read-only scan/sync preparation and removes listeners after a normal response.
 */
function signalFor(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  /**
   * 中止当前 HTTP 关联的本机只读扫描。
   * EN: Aborts the local read-only scan associated with this HTTP request.
   */
  const abort = () => controller.abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) abort();
    request.raw.removeListener('aborted', abort);
  });
  return controller.signal;
}
/**
 * 本地资源采用扫描→选择→带版本同步的流程，配置写入携带 commandId 以处理网络重试。 MCP 检测是独立显式操作，导入配置本身不连接外部服务；HTTP 输入先接受有界 schema 校验。
 * EN: Uses scan, selection, and revision-bound synchronization; writes carry commandId for network retries. MCP inspection is separate and explicit, while import itself never connects. HTTP input passes bounded schemas first.
 */
export function registerLocalAgentRoutes(
  app: FastifyInstance,
  store: Store,
  gateway: ToolGateway,
  prefix = '',
) {
  const service = new LocalAgentSync(store);
  app.addHook('onClose', async () => {
    service.close();
  });
  /**
   * 将公开同步目录与内置技能目录合并，默认读取当前概览，不额外展开正文。
   * EN: Combines public sync overview with built-in skills, defaulting to the current overview without expanding bodies.
   */
  const view = (value = service.overview()) => ({ ...value, builtinSkills: listSkills() });
  app.get(prefix + '/api/local-agents', () => view());
  app.post(prefix + '/api/local-agents/scan', async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(['codex', 'claude', 'dsh', 'antigravity']),
        root: z.string().min(1).max(2048).optional(),
      })
      .strict()
      .parse(request.body);
    return service.scan(body.kind, body.root, signalFor(request, reply));
  });
  app.post(prefix + '/api/local-agents/sync', async (request, reply) => {
    const body = Command.extend({
      scanId: z.string().min(1).max(160),
      ids: z.array(identifier).min(1).max(500),
      expectedRevision: revision,
    })
      .strict()
      .parse(request.body);
    return view(
      await service.sync(
        body.scanId,
        body.ids,
        body.expectedRevision,
        signalFor(request, reply),
        body.commandId,
      ),
    );
  });
  app.post(prefix + '/api/local-agents/items/:id', async (request) => {
    const { id } = z.object({ id: identifier }).parse(request.params);
    const body = Command.extend({
      enabled: z.boolean().optional(),
      remove: z.boolean().optional(),
      config: configSchema.optional(),
      expectedRevision: revision,
    })
      .strict()
      .parse(request.body);
    return view(
      await service.update(
        id,
        { enabled: body.enabled, remove: body.remove, config: body.config },
        body.expectedRevision,
        body.commandId,
      ),
    );
  });
  app.get(prefix + '/api/local-agents/items/:id', (request) => {
    const { id } = z.object({ id: identifier }).parse(request.params);
    const options = z
      .object({
        offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z.coerce.number().int().min(1).max(16000).default(16000),
        query: z.string().max(240).optional(),
      })
      .parse(request.query);
    return service.preview(id, options);
  });
  app.post(prefix + '/api/local-agents/mcp/:id/check', async (request, reply) => {
    const { id } = z.object({ id: identifier }).parse(request.params);
    return gateway.mcp.inspect(readLocalMcpConfig(store, id), signalFor(request, reply));
  });
  return service;
}
