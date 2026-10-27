/**
 * 限制运行与消息历史窗口，并合并分页结果。
 * 在固定容量内合并旧消息和运行页，保留排序、游标及选择所需记录；不从截断窗口推断完整历史。
 * EN: Bounds retained run/message history and merges paginated results. Merges older message/run pages within fixed capacity while retaining order, cursors, and selected records, without treating a truncated window as full history.
 */
import type { Message, RunListItem } from '../../../packages/contracts/src/index';

/**
 * 页面大小控制单次读取，窗口上限控制客户端累计保留量；两者不是服务端记录总量。
 * EN: Page size limits a single read; the window cap limits accumulated client retention. Neither is the total server record count.
 */
export const runHistoryPageSize = 30;
export const runHistoryWindowLimit = 300;
export const messageHistoryPageSize = 40;
export const messageHistoryWindowLimit = 240;

/**
 * 合并旧页与当前页；同 ID 保留较高 revision，避免分页覆盖较新的消息。
 * EN: Merge older and current pages, keeping the higher revision for a duplicate ID so pagination cannot replace a newer message.
 */
export function earlierMessages(earlier: Message[], current: Message[]): Message[] {
  const messages = new Map(earlier.map((message) => [message.id, message]));
  for (const message of current) {
    const prior = messages.get(message.id);
    if (!prior || message.revision >= prior.revision) messages.set(message.id, message);
  }
  return [...messages.values()];
}

/**
 * 已保留行须由服务端重新核验，包括已删除或改名的搜索结果。
 * EN: Retained rows are revalidated by the server, including deleted/renamed search results.
 */
export function retainedRuns(current: RunListItem[], page: RunListItem[], included: RunListItem[]) {
  /**
   * 已显示的行须存在于服务端本次返回的 page 或 included，且仍匹配查询。
   * EN: A visible row must occur in the returned page or included set and must still match the query.
   */
  const available = new Map([...page, ...included].map((run) => [run.id, run]));
  const rows = new Map<string, RunListItem>();
  for (const previous of current) {
    const updated = available.get(previous.id);
    if (updated && updated.matchesQuery !== false) rows.set(updated.id, updated);
  }
  for (const run of page) if (run.matchesQuery !== false) rows.set(run.id, run);
  return [...rows.values()];
}
