/* 限制运行与消息历史窗口，并合并分页结果。 */
import type { Message, RunListItem } from '../../../packages/contracts/src/index';

export const runHistoryPageSize = 30;
export const runHistoryWindowLimit = 300;
export const messageHistoryPageSize = 40;
export const messageHistoryWindowLimit = 240;

/** 合并旧页与当前页；同 ID 保留较高 revision，避免分页覆盖较新的消息。 */
export function earlierMessages(earlier: Message[], current: Message[]): Message[] {
  const messages = new Map(earlier.map((message) => [message.id, message]));
  for (const message of current) {
    const prior = messages.get(message.id);
    if (!prior || message.revision >= prior.revision) messages.set(message.id, message);
  }
  return [...messages.values()];
}

/** Retained rows are revalidated by the server, including deleted/renamed search results. */
export function retainedRuns(current: RunListItem[], page: RunListItem[], included: RunListItem[]) {
  // 已显示的行须存在于服务端本次返回的 page 或 included，且仍匹配查询。
  const available = new Map([...page, ...included].map((run) => [run.id, run]));
  const rows = new Map<string, RunListItem>();
  for (const previous of current) {
    const updated = available.get(previous.id);
    if (updated && updated.matchesQuery !== false) rows.set(updated.id, updated);
  }
  for (const run of page) if (run.matchesQuery !== false) rows.set(run.id, run);
  return [...rows.values()];
}
