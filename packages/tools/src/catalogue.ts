// 为本地资源和 MCP 工具目录提供有界分页。
import { invariant } from '../../contracts/src/index.js';
import { hash } from '../../storage/src/index.js';
import type { McpInspection, McpTool } from './mcp-client.js';
export const MCP_CATALOGUE_BYTES = 16000;
const MCP_INLINE_SCHEMA_BYTES = 6000;
/** 令 UTF-16 截断点落在完整代理对之前；索引仍使用字符串单元，不转换为 UTF-8 字节偏移。 */
export function unicodeBoundary(value: string, offset: number) {
  // 分页不能把 UTF-16 代理对拆开，否则下一页会出现损坏的字符。
  const end = Math.min(offset, value.length);
  return end > 0 &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
    ? end - 1
    : end;
}
/** 按字符单元预限长，保持代理对完整，随后仍需接受目录 JSON 字节预算约束。 */
function clipMcpText(value: string, limit: number) {
  return value.slice(0, unicodeBoundary(value, limit));
}
/** 按每个字符 JSON 编码后的 UTF-8 开销逐个加入，转义符成本也计入而不是只数文本长度。 */
function clipCatalogueText(value: string, byteLimit: number) {
  let text = '',
    bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes + size > byteLimit) break;
    text += character;
    bytes += size;
  }
  return text;
}
/**
 * 过滤并分页本地目录，按 JSON 双重编码后的字节预算限制结果。
 * 空间不足时可省略首条描述；连一条记录也容不下时明确报错，避免返回无法推进的游标。
 */
export function localCataloguePage(
  items: { id: string; name: string; description?: string }[],
  args: { query?: string; offset: number; limit: number },
  trust: string,
  byteBudget: number,
) {
  const query = (args.query || '').toLocaleLowerCase(),
    matched = items.filter((item) =>
      `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(query),
    );
  const entries: { id: string; name: string; description?: string; descriptionOmitted?: boolean }[] = [];
  const page = () => ({
    entries,
    total: matched.length,
    nextOffset: args.offset + entries.length < matched.length ? args.offset + entries.length : null,
    trust,
  });
  for (const item of matched.slice(args.offset, args.offset + args.limit)) {
    entries.push({
      id: item.id,
      name: clipCatalogueText(item.name, 64),
      ...(item.description ? { description: clipCatalogueText(item.description, 160) } : {}),
    });
    // 结果进入历史时还会再编码一次，按两层 JSON 的字节数预留空间。
    if (Buffer.byteLength(JSON.stringify(JSON.stringify(page())), 'utf8') <= byteBudget * 0.75) continue;
    if (entries.length === 1) {
      delete entries[0].description;
      entries[0].descriptionOmitted = true;
      if (Buffer.byteLength(JSON.stringify(JSON.stringify(page())), 'utf8') <= byteBudget * 0.75) continue;
    }
    entries.pop();
    break;
  }
  invariant(
    entries.length || args.offset >= matched.length,
    'CATALOGUE_PAGE_LIMIT',
    '当前窗口无法容纳一条目录，请增大窗口',
  );
  return page();
}
/**
 * 在有限预算内分页 MCP 工具目录；指定 schemaTool 时单独分页其 JSON Schema，
 * 返回摘要供调用方判断跨页期间内容是否变化。服务端资料标记为不可信。
 */
export function mcpCataloguePage(
  inspection: McpInspection,
  args: {
    serverId: string;
    query?: string;
    offset: number;
    limit: number;
    schemaTool?: string;
    schemaOffset: number;
  },
  byteBudget: number,
) {
  const metadata = {
    serverId: args.serverId,
    protocolVersion: inspection.protocolVersion,
    truncated: inspection.truncated,
    trust: 'untrusted' as const,
  };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const historyBytes = (value: unknown) => bytes(JSON.stringify(value));
  const historyBudget = Math.max(768, Math.floor(byteBudget * 0.75));
  if (args.schemaTool) {
    const tool = inspection.tools.find((item) => item.name === args.schemaTool);
    invariant(tool, 'MCP_TOOL_NOT_FOUND', 'MCP 工具不存在或未允许');
    const schema = JSON.stringify(tool.inputSchema),
      start = unicodeBoundary(schema, args.schemaOffset),
      schemaHash = hash(schema);
    const page = (end: number) => ({
      serverId: args.serverId,
      trust: 'untrusted' as const,
      schemaTool: tool.name,
      schemaHash,
      schemaOffset: start,
      schemaText: schema.slice(start, end),
      totalCharacters: schema.length,
      nextSchemaOffset: end < schema.length ? end : null,
    });
    // 对编码后整页大小二分，既考虑 Schema 文本的转义膨胀，也考虑页元数据；每次候选避开代理对中间。
    let low = start,
      high = Math.min(schema.length, start + 8000);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2),
        end = unicodeBoundary(schema, middle);
      if (historyBytes(page(end)) <= historyBudget) low = middle;
      else high = middle - 1;
    }
    const end = unicodeBoundary(schema, low);
    invariant(
      end > start || start === schema.length,
      'MCP_CATALOGUE_LIMIT',
      '当前窗口无法容纳schema分页，请增大窗口',
    );
    return page(end);
  }
  const query = (args.query || '').toLocaleLowerCase(),
    matched = inspection.tools.filter((tool) =>
      `${tool.name} ${tool.title || ''} ${tool.description || ''}`.toLocaleLowerCase().includes(query),
    );
  const tools: Array<Record<string, unknown>> = [];
  const page = () => ({
    ...metadata,
    tools,
    total: matched.length,
    offset: args.offset,
    nextOffset: args.offset + tools.length < matched.length ? args.offset + tools.length : null,
  });
  const entry = (tool: McpTool) => {
    const schemaBytes = bytes(tool.inputSchema),
      annotations = Object.fromEntries(
        ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
          .filter((key) => typeof tool.annotations?.[key] === 'boolean')
          .map((key) => [key, tool.annotations![key]]),
      );
    return {
      name: tool.name,
      ...(tool.title ? { title: clipCatalogueText(clipMcpText(tool.title, 120), 96) } : {}),
      ...(tool.description
        ? { description: clipCatalogueText(clipMcpText(tool.description, 240), 160) }
        : {}),
      ...(Object.keys(annotations).length ? { annotations } : {}),
      schemaBytes,
      ...(schemaBytes <= MCP_INLINE_SCHEMA_BYTES
        ? { inputSchema: tool.inputSchema }
        : { schemaOmitted: true, schemaTool: tool.name }),
    };
  };
  for (const tool of matched.slice(args.offset, args.offset + args.limit)) {
    const value = entry(tool);
    tools.push(value);
    if (historyBytes(page()) <= historyBudget) continue;
    // 先降级为单独读取 Schema，再缩短描述；仍放不下才撤回本条，不能返回预算外的部分定义。
    const omitted: Record<string, unknown> = { ...value, schemaOmitted: true, schemaTool: tool.name };
    delete omitted.inputSchema;
    tools[tools.length - 1] = omitted;
    if (historyBytes(page()) <= historyBudget) continue;
    if (tools.length === 1) {
      delete omitted.annotations;
      if (typeof omitted.title === 'string') omitted.title = clipCatalogueText(omitted.title, 32);
      if (typeof omitted.description === 'string')
        omitted.description = clipCatalogueText(omitted.description, 64);
      if (historyBytes(page()) <= historyBudget) continue;
      delete omitted.title;
      delete omitted.description;
      if (historyBytes(page()) <= historyBudget) continue;
    }
    tools.pop();
    break;
  }
  invariant(
    tools.length || args.offset >= matched.length,
    'MCP_CATALOGUE_LIMIT',
    '当前窗口无法容纳一个MCP工具，请增大窗口',
  );
  return page();
}
