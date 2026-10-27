/**
 * 按限制读取任务当前待答问题，区分不可用记录与正常结果。
 * EN: Read current unanswered task questions within explicit limits and distinguish unavailable
 * records from ordinary results.
 *
 * 读取使用显式条数和可用性结果，保留正常空集合与损坏、超限等异常的区别，供上下文和详情投影作出正确判断。
 * EN: Use explicit limits and availability results to distinguish an ordinary empty set from corruption or overflow for context and detail projections.
 */
import { gunzipSync } from 'node:zlib';
import type { Run, Task } from '../../contracts/src/index.js';
import type { RunCurrentQuestions } from '../../contracts/src/run-reads.js';
import type { Store } from './index.js';

export const CURRENT_QUESTION_LIMITS = {
  tasks: 12,
  eventsPerType: 128,
  bodyBytes: 256 * 1024,
  totalBytes: 2 * 1024 * 1024,
} as const;
type EventRow = {
  seq: number;
  event_id: string;
  task_id: string;
};
type EventBody = {
  content: Uint8Array | null;
  payload: string | null;
  oversized: number;
};
class UnavailableQuestion extends Error {
  /**
   * 用limited区分预算截断与普通不可读问题，不携带未验证正文。
   * EN: Distinguish budget truncation from ordinary unavailability through limited, without carrying unverified bodies.
   */
  constructor(public limited = false) {
    super('Current question unavailable');
  }
}
/**
 * 只把非空非数组对象作为可解析事件结构。
 * EN: Accept only non-null, non-array objects as event records.
 */
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 查找运行中仍等待用户回答的问题，并用事件前后的任务状态核验其有效性。
 * 读取受任务数、事件数和字节预算限制；无法核验的任务写入 coverage，不能当作没有问题。
 * EN: Find questions still awaiting a user response and verify their validity against task states
 * before and after the question event. Bound task count, event count, and bytes; report unverifiable
 * tasks in coverage instead of treating them as having no questions.
 */
export function readCurrentQuestions(
  store: Store,
  run: Run,
  tasks: readonly Task[],
  unavailableTaskIds: readonly string[] = [],
): RunCurrentQuestions {
  const result: RunCurrentQuestions = {
    items: [],
    coverage: { complete: true, unavailable: 0, limited: false },
    unavailableTaskIds: [],
  };
  if (['DONE', 'CANCELLED'].includes(run.status) || run.execution?.kind === 'docker-agent') return result;
  const belongs = store.db.prepare('SELECT run_id FROM tasks WHERE id=?');
  const unavailable = new Set(unavailableTaskIds.filter((id) => belongs.get(id)?.run_id === run.id));
  let remaining = CURRENT_QUESTION_LIMITS.totalBytes;
  // 候选查询仅携带有索引的身份字段，按需读取一条有界正文。
  // EN: Candidate queries carry only indexed identity fields; read one bounded body on demand.
  const select = 'seq,event_id,task_id';
  const body = store.db.prepare(`SELECT
    CASE WHEN length(content)<=${CURRENT_QUESTION_LIMITS.bodyBytes} THEN content END content,
    CASE WHEN length(CAST(payload AS BLOB))<=${CURRENT_QUESTION_LIMITS.bodyBytes} THEN payload END payload,
    CASE WHEN content IS NOT NULL THEN length(content)>${CURRENT_QUESTION_LIMITS.bodyBytes}
      ELSE length(CAST(payload AS BLOB))>${CURRENT_QUESTION_LIMITS.bodyBytes} END oversized
    FROM events WHERE run_id=? AND seq=? AND task_id=?`);
  /**
   * 有界读取、解压并解析单条事件正文，扣减共享预算并校验任务归属。
   * EN: Bound and decode one event body, charge the shared budget, and validate task ownership.
   */
  const decode = (row: EventRow, task: Task): Record<string, unknown> => {
    // 每条正文单独有界读取，整个请求还共享剩余解压预算，坏压缩数据也要消耗其尝试额度。
    // EN: Bound each body read and share a total decompression budget across the request. Corrupt
    // compressed input also consumes its attempted allowance.
    if (remaining <= 0) throw new UnavailableQuestion(true);
    const stored = body.get(run.id, row.seq, task.id) as EventBody | undefined;
    if (!stored) throw new UnavailableQuestion();
    if (stored.oversized) throw new UnavailableQuestion(true);
    const budget = Math.min(CURRENT_QUESTION_LIMITS.bodyBytes, remaining);
    let text: string;
    try {
      if (stored.content) {
        let buffer: Buffer;
        try {
          buffer = gunzipSync(stored.content, { maxOutputLength: budget });
        } catch (error) {
          // CRC或尾部损坏可能在解压器已经产出全部内容后才报错。
          // EN: Corrupt CRC or trailer data may be rejected only after decompression has produced the full
          // output.
          remaining -= budget;
          throw error;
        }
        remaining -= buffer.length;
        text = buffer.toString('utf8');
      } else {
        if (stored.payload === null) throw new UnavailableQuestion();
        const bytes = Buffer.byteLength(stored.payload);
        if (bytes > remaining) throw new UnavailableQuestion(true);
        remaining -= bytes;
        text = stored.payload;
      }
      const value: unknown = JSON.parse(text);
      // 没有独立有界读取器时，不展开历史格式的外部正文。
      // EN: Do not expand legacy external bodies without an independently bounded reader.
      if (
        !object(value) ||
        'externalPayloadRef' in value ||
        row.task_id !== task.id ||
        (value.taskId !== undefined && value.taskId !== task.id)
      )
        throw new UnavailableQuestion();
      return value;
    } catch (error) {
      if (error instanceof UnavailableQuestion) throw error;
      const limited = (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
      throw new UnavailableQuestion(limited);
    }
  };
  /**
   * 验证状态事件身份与合法状态后，判断它是否仍为等待用户。
   * EN: Validate a state event identity/status and determine whether it still waits for the user.
   */
  const state = (row: EventRow, task: Task) => {
    // 事件外层索引与正文身份都要匹配，防止错行或旧格式正文把其他任务的问题带入当前列表。
    // EN: Match both indexed event identity and body identity so a wrong row or legacy body cannot
    // import another task question.
    const value = decode(row, task);
    if (
      value.id !== task.id ||
      value.runId !== run.id ||
      !['DRAFT', 'READY', 'RUNNING', 'WAITING', 'VERIFYING', 'DONE', 'FAILED', 'CANCELLED'].includes(
        value.status as string,
      ) ||
      (value.waitReason !== undefined && typeof value.waitReason !== 'string')
    )
      throw new UnavailableQuestion();
    return value.status === 'WAITING' && value.waitReason === 'user';
  };
  const waiting = tasks.filter((task) => task.status === 'WAITING' && task.waitReason === 'user');
  for (let index = 0; index < waiting.length; index++) {
    const task = waiting[index];
    // 即使调用方误传其他运行的任务，也不回显其ID或正文。
    // EN: Do not echo a foreign task ID or body even if the caller supplies it accidentally.
    if (task.runId !== run.id || belongs.get(task.id)?.run_id !== run.id) continue;
    try {
      if (index >= CURRENT_QUESTION_LIMITS.tasks) throw new UnavailableQuestion(true);
      const decisions = store.db
        .prepare(
          `SELECT ${select} FROM events
        WHERE run_id=? AND task_id=? AND type='decision.required' ORDER BY seq DESC LIMIT ?`,
        )
        .all(run.id, task.id, CURRENT_QUESTION_LIMITS.eventsPerType + 1) as EventRow[];
      let candidate: { row: EventRow; questions: string[] } | undefined;
      // 模型交接和普通聊天等待可能没有澄清问题事件。
      // EN: Model handoffs and ordinary chat waits may have no clarification event.
      if (!decisions.length) continue;
      for (const row of decisions.slice(0, CURRENT_QUESTION_LIMITS.eventsPerType)) {
        const value = decode(row, task);
        if (value.questions === undefined) continue;
        if (
          value.reason !== 'user' ||
          !Array.isArray(value.questions) ||
          !value.questions.length ||
          value.questions.length > 6 ||
          !value.questions.every((question) => typeof question === 'string' && !!question.trim())
        )
          throw new UnavailableQuestion();
        candidate = { row, questions: value.questions as string[] };
        break;
      }
      if (!candidate) {
        if (decisions.length > CURRENT_QUESTION_LIMITS.eventsPerType) throw new UnavailableQuestion(true);
        // 普通的纯文本聊天等待可以没有澄清问题。
        // EN: An ordinary text-only chat wait may legitimately contain no clarification question.
        continue;
      }
      // 提问时必须处于等待用户状态；之后若离开该状态，旧问题视为已处理。
      // EN: Require the task to be waiting for the user when the question was asked; leaving that state
      // afterwards means the old question was handled.
      const before = store.db
        .prepare(
          `SELECT ${select} FROM events WHERE run_id=? AND task_id=?
        AND type='task.updated' AND seq<=? ORDER BY seq DESC LIMIT 1`,
        )
        .get(run.id, task.id, candidate.row.seq) as EventRow | undefined;
      if (!before || !state(before, task)) throw new UnavailableQuestion();
      const after = store.db
        .prepare(
          `SELECT ${select} FROM events WHERE run_id=? AND task_id=?
        AND type='task.updated' AND seq>? ORDER BY seq ASC LIMIT ?`,
        )
        .all(run.id, task.id, candidate.row.seq, CURRENT_QUESTION_LIMITS.eventsPerType + 1) as EventRow[];
      let answered = false;
      for (const row of after.slice(0, CURRENT_QUESTION_LIMITS.eventsPerType)) {
        if (!state(row, task)) {
          answered = true;
          break;
        }
      }
      if (answered) continue;
      // 没看到状态离开等待，并不证明截断范围以外没有回答；超限必须报告无法确认。
      // EN: Not observing a departure from the waiting state does not prove there was no answer outside
      // the bounded scan. Report uncertainty when the scan limit is reached.
      if (after.length > CURRENT_QUESTION_LIMITS.eventsPerType) throw new UnavailableQuestion(true);
      result.items.push({
        eventId: candidate.row.event_id,
        taskId: task.id,
        title: task.spec.role === 'coordinator' ? '总代理' : task.spec.title,
        questions: candidate.questions,
        seq: candidate.row.seq,
      });
    } catch (error) {
      if (!(error instanceof UnavailableQuestion)) throw error;
      unavailable.add(task.id);
      result.coverage.limited ||= error.limited;
    }
  }
  result.items.sort((a, b) => a.seq - b.seq);
  result.unavailableTaskIds = [...unavailable];
  result.coverage.unavailable = unavailable.size;
  result.coverage.complete = unavailable.size === 0;
  return result;
}
