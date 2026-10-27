/**
 * 提供上下文编译、快照和技能加载的公共入口。
 * 公开入口协调快照、纯编译和对象持久化，历史回查必须证明引用属于当前代理。
 *
 * EN: Exposes context compilation, snapshot capture, and skill-loading entry points.
 * Coordinates capture, pure compilation, and persistence; history recall must prove agent-owned references.
 */
import {
  AppError,
  ContextRuntimeMetrics,
  type Task,
  type Agent,
  type Message,
} from '../../contracts/src/index.js';
import { Store, stable } from '../../storage/src/index.js';

export { compactHistory, headTail, COMPACTION_ALGORITHM } from './compaction.js';
export { listSkills, loadSkill, SKILL_CATALOG_VERSION } from './skills.js';
export type { SkillSummary, LoadedSkill } from './skills.js';
import type { CompiledContext, ToolDefinition } from '../../contracts/src/model.js';

export { validatePairs } from '../../contracts/src/model.js';
export type { CompiledContext, ToolDefinition } from '../../contracts/src/model.js';
export { collectContextSnapshot, type ContextSourceSnapshot } from './snapshot.js';
export { compileContextSnapshot, type ContextCompilation } from './compiler.js';
import { collectContextSnapshot } from './snapshot.js';
import { compileContextSnapshot } from './compiler.js';
/**
 * 一次采集并编译，然后在事务中保存引用对象；超预算时保留原始对象并报告限制。
 *
 * EN: Captures and compiles once, then saves referenced objects transactionally; over-budget failures retain originals and report the limit.
 */
export function compileContext(store: Store, task: Task, definitions: ToolDefinition[]): CompiledContext {
  const result = compileContextSnapshot(collectContextSnapshot(store, task, definitions));
  store.tx(() => {
    for (const object of result.objects) store.object(object);
  });
  if (result.blocked)
    throw new AppError(
      'CONTEXT_LIMIT',
      '上下文超过已分配窗口；请增大窗口或缩小不可裁剪的资料，原始历史已保留。',
      false,
      { contextMetrics: result.context.manifest.contextWindow },
    );
  return result.context;
}
/**
 * 只读取该代理请求/事件引用的压缩来源，不接受任意对象引用。
 * 根据上下文引用读取原始内容，供压缩后按需回查。
 *
 * EN: Read only compression sources referenced by this agent's requests/events, never an arbitrary object.
 * Reads originals through context references for on-demand retrieval after compaction.
 */
export function recallContext(
  store: Store,
  task: Task,
  input: {
    reference: string;
    offset?: number;
    limit?: number;
    query?: string;
    textOffset?: number;
    part?: 'text' | 'calls';
  },
) {
  const agent = store.require<Agent>('agents', task.agentId);
  /**
   * 对象本身的内容哈希不等于读取授权；必须先证明它被当前代理的请求或上下文事件引用。
   *
   * EN: An object hash is not read authorization; first prove that this agent request or context event references it.
   */
  const references = new Set<string>();
  for (const record of store.all<any>('requests', task.runId).filter((item) => item.taskId === task.id)) {
    const metrics = record.manifest?.contextWindow;
    if (metrics?.agentId === agent.id && metrics.compression?.originalRef)
      references.add(metrics.compression.originalRef);
  }
  let eventCursor = 0;
  while (!references.has(input.reference)) {
    const events = store.events(task.runId, eventCursor, { taskId: task.id, type: 'context.updated' });
    if (!events.length) break;
    for (const event of events) {
      const metrics = event.payload as Partial<ContextRuntimeMetrics>;
      if (metrics?.agentId === agent.id && metrics.taskId === task.id && metrics.compression?.originalRef)
        references.add(metrics.compression.originalRef);
    }
    eventCursor = events.at(-1)!.seq;
  }
  if (!references.has(input.reference))
    throw new AppError('CONTEXT_REFERENCE_DENIED', '只能回查当前代理的上下文原文引用');
  const captured = JSON.parse(store.readObject(input.reference).toString('utf8'));
  if (
    captured.runId !== task.runId ||
    captured.taskId !== task.id ||
    captured.agentId !== agent.id ||
    !Array.isArray(captured.messages)
  )
    throw new AppError('CONTEXT_REFERENCE_DENIED', '上下文原文归属不匹配');
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 5;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    (input.part !== undefined && input.part !== 'text' && input.part !== 'calls') ||
    (input.textOffset !== undefined && (!Number.isInteger(input.textOffset) || input.textOffset < 0))
  )
    throw new AppError('CONTEXT_RECALL_RANGE', '上下文回查范围无效');
  /**
   * 消息分页与正文分页分开：offset 是匹配消息序号，textOffset 是选中消息的 Unicode 码点偏移。
   *
   * EN: Message paging and text paging are separate: offset selects matched messages while textOffset is a Unicode code-point offset within the selected message.
   */
  const matches = captured.messages
    .map((message: Message, index: number) => ({ message, index }))
    .filter(
      ({ message }: { message: Message }) =>
        !input.query ||
        message.text.includes(input.query) ||
        stable(message.calls ?? []).includes(input.query),
    );
  const selected = matches.slice(offset, offset + limit);
  return {
    reference: input.reference,
    trust: 'historical-data',
    total: matches.length,
    offset,
    nextOffset: offset + selected.length < matches.length ? offset + selected.length : null,
    messages: selected.map(({ message, index }: { message: Message; index: number }) => {
      /**
       * 查询只命中工具参数时默认展示 calls，避免返回不含匹配内容的正文页。
       *
       * EN: If a query matches only tool arguments, defaults to calls instead of returning a text page without the match.
       */
      const part = input.part ?? (input.query && !message.text.includes(input.query) ? 'calls' : 'text');
      const content = part === 'calls' ? stable(message.calls ?? []) : message.text;
      const points = Array.from(content);
      const matchOffset = input.query
        ? Array.from(content.slice(0, Math.max(0, content.indexOf(input.query)))).length
        : 0;
      const textOffset = input.textOffset ?? Math.max(0, matchOffset - 512);
      const nextTextOffset = textOffset + 6000 < points.length ? textOffset + 6000 : null;
      return {
        index,
        id: message.id,
        role: message.role,
        callId: message.callId,
        calls: message.calls?.map(({ id, name }) => ({ id, name })),
        part,
        textOffset,
        totalChars: points.length,
        nextTextOffset,
        text: points.slice(textOffset, textOffset + 6000).join(''),
        truncated: textOffset > 0 || nextTextOffset !== null,
      };
    }),
  };
}
export { requestDifference } from './request-difference.js';
