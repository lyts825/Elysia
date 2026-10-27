// 按限制读取任务当前待答问题，区分不可用记录与正常结果。
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
  constructor(public limited = false) {
    super('Current question unavailable');
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Read only the current question and the state transitions proving it is still unanswered. */
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
  // Candidate queries carry only indexed identity. Read one bounded body on demand.
  const select = 'seq,event_id,task_id';
  const body = store.db.prepare(`SELECT
    CASE WHEN length(content)<=${CURRENT_QUESTION_LIMITS.bodyBytes} THEN content END content,
    CASE WHEN length(CAST(payload AS BLOB))<=${CURRENT_QUESTION_LIMITS.bodyBytes} THEN payload END payload,
    CASE WHEN content IS NOT NULL THEN length(content)>${CURRENT_QUESTION_LIMITS.bodyBytes}
      ELSE length(CAST(payload AS BLOB))>${CURRENT_QUESTION_LIMITS.bodyBytes} END oversized
    FROM events WHERE run_id=? AND seq=? AND task_id=?`);
  const decode = (row: EventRow, task: Task): Record<string, unknown> => {
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
          // Corrupt CRC/trailers may fail only after producing the entire output.
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
      // External legacy bodies cannot be expanded without an independently bounded reader.
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
  const state = (row: EventRow, task: Task) => {
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
    // Do not echo a foreign task's ID or body even if a caller supplies it accidentally.
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
      // Model handoff and ordinary chat waits can have no clarification event.
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
        // No clarification is valid for ordinary text-only chat waits.
        continue;
      }
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
