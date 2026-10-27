/**
 * 为本地资源和 MCP 工具目录提供有界分页。
 * EN: Provide bounded pagination for local resources and MCP tool catalogues.
 *
 * 目录结果保留游标及读取上限，为模型逐页发现资源提供稳定入口；具体内容读取仍由相应工具能力执行。
 * EN: Retain cursors and limits for incremental resource discovery; the corresponding tool capability still owns content reads.
 */
import { invariant } from '../../contracts/src/index.js';
import { hash } from '../../storage/src/index.js';
import type { McpInspection, McpTool } from './mcp-client.js';
export const MCP_CATALOGUE_BYTES = 16000;
const MCP_INLINE_SCHEMA_BYTES = 6000;
/**
 * 令 UTF-16 截断点落在完整代理对之前；索引仍使用字符串单元，不转换为 UTF-8 字节偏移。
 * EN: Move UTF-16 cut points before a split surrogate pair. Indices remain string-unit offsets, not
 * UTF-8 byte offsets.
 */
export function unicodeBoundary(value: string, offset: number) {
  // 分页不能把 UTF-16 代理对拆开，否则下一页会出现损坏的字符。
  // EN: Do not split UTF-16 surrogate pairs across pages, which would produce broken characters.
  const end = Math.min(offset, value.length);
  return end > 0 &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
    ? end - 1
    : end;
}
/**
 * 按字符单元预限长，保持代理对完整，随后仍需接受目录 JSON 字节预算约束。
 * EN: Pre-limit string units at complete-character boundaries, while still enforcing the later JSON
 * byte budget.
 */
function clipMcpText(value: string, limit: number) {
  return value.slice(0, unicodeBoundary(value, limit));
}
/**
 * 按每个字符 JSON 编码后的 UTF-8 开销逐个加入，转义符成本也计入而不是只数文本长度。
 * EN: Add characters according to their JSON-encoded UTF-8 cost, including escapes rather than
 * counting raw text length.
 */
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
 * EN: Filter and page local catalogue entries within a doubly JSON-encoded byte budget. Omit the
 * first description if needed; fail explicitly if even one entry cannot fit, avoiding a cursor that
 * cannot advance.
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
  /**
   * 组合当前条目与下一偏移，供JSON字节预算估算与最终返回复用。
   * EN: Build entries and next-offset metadata for both JSON budget estimation and the final response.
   */
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
    // EN: History serializes the result again, so budget for both layers of JSON encoding.
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
 * EN: Page MCP definitions within the budget. schemaTool selects separate JSON Schema paging with a
 * digest for detecting changes between pages. Mark server-provided material untrusted.
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
  /**
   * 计算一次JSON编码后的UTF-8大小，包含结构与转义开销。
   * EN: Measure UTF-8 bytes after JSON encoding, including structural and escape overhead.
   */
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  /**
   * 估算结果写入历史时再次JSON编码的大小，而非只量Schema文本。
   * EN: Measure the second JSON encoding used in history rather than schema text alone.
   */
  const historyBytes = (value: unknown) => bytes(JSON.stringify(value));
  const historyBudget = Math.max(768, Math.floor(byteBudget * 0.75));
  if (args.schemaTool) {
    const tool = inspection.tools.find((item) => item.name === args.schemaTool);
    invariant(tool, 'MCP_TOOL_NOT_FOUND', 'MCP 工具不存在或未允许');
    const schema = JSON.stringify(tool.inputSchema),
      start = unicodeBoundary(schema, args.schemaOffset),
      schemaHash = hash(schema);
    /**
     * 构造指定Schema终点的页面与哈希/偏移元数据，供二分预算检验。
     * EN: Build a schema page for a candidate end with digest/offset metadata for binary-search budget checks.
     */
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
    // EN: Binary-search the encoded whole-page size, accounting for schema escaping and page metadata;
    // move candidate boundaries away from split surrogate pairs.
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
  /**
   * 组合工具目录当前页与分页状态，确保估算与实际返回使用相同结构。
   * EN: Compose the catalogue page and paging state so budgeting matches the returned structure.
   */
  const page = () => ({
    ...metadata,
    tools,
    total: matched.length,
    offset: args.offset,
    nextOffset: args.offset + tools.length < matched.length ? args.offset + tools.length : null,
  });
  /**
   * 裁剪远端描述并筛选已知布尔注释，大Schema以可单独分页的标记替代。
   * EN: Clip remote descriptions, retain recognized boolean annotations, and replace oversized schemas with explicit paging markers.
   */
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
    // EN: First omit the inline schema, then shorten descriptions. If the entry still cannot fit, remove
    // it rather than returning a partial over-budget definition.
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
