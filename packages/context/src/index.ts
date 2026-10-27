// 提供上下文编译、快照和技能加载的公共入口。
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
/** Read only compression sources referenced by this agent's requests/events, never an arbitrary object. */
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
