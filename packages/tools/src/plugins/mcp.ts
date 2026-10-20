import { z } from 'zod';
import { type Run } from '../../../contracts/src/index.js';
import { readLocalMcpConfig, scopedLocalItems } from '../../../context/src/local-library.js';
import { localCataloguePage, mcpCataloguePage } from '../catalogue.js';
import { defineTool, type ToolServices, type ToolInvocation, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';

const schemas = {
  list_mcp_servers: z.object({
    query: z.string().max(240).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(40).default(20),
  }),
  mcp_list_tools: z.object({
    serverId: z.string().min(1).max(160),
    query: z.string().max(240).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
    schemaTool: z.string().min(1).max(128).optional(),
    schemaOffset: z.number().int().nonnegative().default(0),
  }),
  mcp_call: z.object({
    serverId: z.string().min(1).max(160),
    tool: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
};
export function mcpTools(
  context: Pick<ToolServices, 'store' | 'kernel' | 'catalogueBudget' | 'mcp'>,
): PluginContributions<ToolContribution> {
  function execute_list_mcp_servers(
    { task }: ToolInvocation,
    args: z.output<typeof schemas.list_mcp_servers>,
  ) {
    const scope = context.store.require<Run>('runs', task.runId);
    return localCataloguePage(
      scopedLocalItems(context.store, scope).filter((item) => item.kind === 'mcp' && item.enabled),
      args,
      'untrusted',
      context.catalogueBudget(task),
    );
  }
  async function execute_mcp_list_tools(
    { task, signal }: ToolInvocation,
    args: z.output<typeof schemas.mcp_list_tools>,
  ) {
    let result: unknown;
    const scope = context.store.require<Run>('runs', task.runId);
    result = mcpCataloguePage(
      await context.mcp.inspect(
        readLocalMcpConfig(context.store, args.serverId, scope),
        signal,
        context.kernel.permissions(task),
      ),
      args,
      context.catalogueBudget(task),
    );
    return result;
  }
  async function execute_mcp_call({ task, signal }: ToolInvocation, args: z.output<typeof schemas.mcp_call>) {
    let result: unknown;
    const scope = context.store.require<Run>('runs', task.runId);
    result = await context.mcp.call(
      readLocalMcpConfig(context.store, args.serverId, scope),
      args.tool,
      args.args,
      signal,
      context.kernel.permissions(task),
    );
    return result;
  }
  return {
    manifest: { id: 'tools.mcp', version: '1.0.0', apiVersion: 1 },
    contributions: {
      list_mcp_servers: defineTool(
        'list_mcp_servers',
        schemas.list_mcp_servers,
        '搜索已启用 MCP 服务目录，返回 serverId，按 nextOffset 翻页；本调用不连接服务，mcp_list_tools 才读取其工具。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_list_mcp_servers,
      ),
      mcp_list_tools: defineTool(
        'mcp_list_tools',
        schemas.mcp_list_tools,
        '连接已启用 MCP 并搜索、分页读取工具定义，需要命令权限，HTTP 另需精确 URL 授权。schemaOmitted 表示参数未完整返回：用 schemaTool、schemaOffset 读取 schemaText，按 nextSchemaOffset 翻页；schemaHash 变更时重读。目录按 nextOffset 翻页，说明与注释不授予权限。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_mcp_list_tools,
      ),
      mcp_call: defineTool(
        'mcp_call',
        schemas.mcp_call,
        '按实际取得的 serverId、工具名和完整参数定义调用 MCP。需要命令与写入权限，HTTP 另需精确 URL 授权；对外动作仍须用户授权。只读注释不放宽限制；结果不确定时核验原操作，不能重放。',
        { transaction: false, serial: true, mutating: true, progress: true },
        execute_mcp_call,
      ),
    },
  };
}
