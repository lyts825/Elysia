/**
 * 校验并读取对象维护审计数据。
 * 有界核对 JSONL 审计的计划绑定及删除事件配对，损坏/缺失保持未知或不完整；日志本身不产生新的删除授权。
 * EN: Validates and reads object-maintenance audit data. Boundedly verifies audit plan binding/deletion pairs; damage or missing events remain unknown/incomplete and logs grant no new deletion authority.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { hash, stable } from '../../../packages/storage/src/index.js';
import { ObjectCleanupPlan } from './object-maintenance.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const headerSchema = z
  .object({
    type: z.literal('started'),
    format: z.literal(2),
    createdAt: z.string().datetime(),
    planHash: digest,
    scope: digest,
    surfaces: z
      .array(z.object({ surface: z.enum(['native', 'terminal']), database: digest }).strict())
      .min(1)
      .max(2),
  })
  .strict();

/**
 * 对象键规范排序，数组顺序仍属于原执行计划的一部分。 验证对象清理计划并提取入口及候选对象的审计绑定信息。
 * EN: Object keys are canonicalized; array order remains part of the original execution plan. Validates cleanup plans and extracts audit binding for surfaces and selected objects.
 */
export function objectAuditPlan(value: unknown) {
  const plan = ObjectCleanupPlan.parse(value);
  const surfaces = new Set<string>(),
    candidates = new Map<string, number>();
  for (const entry of plan.surfaces) {
    if (surfaces.has(entry.surface)) throw new Error('Invalid cleanup plan');
    surfaces.add(entry.surface);
    for (const candidate of entry.candidates) {
      const key = entry.surface + '/' + candidate.ref;
      if (candidates.has(key) || !Number.isSafeInteger(candidate.bytes))
        throw new Error('Invalid cleanup plan');
      candidates.set(key, candidate.bytes);
    }
  }
  return {
    planHash: hash(stable(plan)),
    scope: plan.scope,
    surfaces: plan.surfaces.map(({ surface, database }) => ({ surface, database })),
    candidates,
  };
}

/**
 * 生成审计开始记录，包含计划绑定信息但不复制候选对象清单。
 * EN: Creates an audit start record with plan binding but without duplicating the candidate list.
 */
export function objectAuditHeader(plan: unknown) {
  const { candidates: _, ...binding } = objectAuditPlan(plan);
  return { type: 'started' as const, format: 2 as const, createdAt: new Date().toISOString(), ...binding };
}

type Binding = {
  status: 'verified' | 'unbound' | 'mismatch' | 'invalid';
  reason?:
    | 'plan_not_provided'
    | 'legacy_format'
    | 'missing_header'
    | 'plan_invalid'
    | 'plan_mismatch'
    | 'candidate_mismatch'
    | 'audit_invalid';
};

/**
 * 回执只与可选计划比较，不与当前数据库或文件状态比较。 读取有界 JSONL 审计并可选绑定原执行计划。必须具备完整行分隔和正确的开始/结束顺序； delete-started 没有对应完成记录时标记 incomplete，不能由退出状态推断文件未被删除。 verified 只证明该回执与给定计划一致，不重新证明当前数据库或对象文件的状态。
 * EN: Verifies a receipt against an optional plan, never against current database or file state. Reads bounded JSONL audits and optionally binds the original plan. Requires complete delimiters and valid start/end order; unmatched delete-started records mean incomplete, not proof that deletion never happened. verified proves receipt/plan consistency only, not current database or object state.
 */
export function inspectObjectAudit(filename: string, suppliedPlan?: unknown) {
  try {
    if (!existsSync(filename)) return { available: false as const };
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      return { available: false as const };
    let plan: ReturnType<typeof objectAuditPlan> | undefined;
    let binding: Binding = { status: 'unbound', reason: 'missing_header' };
    if (suppliedPlan !== undefined) {
      try {
        plan = objectAuditPlan(suppliedPlan);
      } catch {
        binding = { status: 'invalid', reason: 'plan_invalid' };
      }
    }
    const pending = new Map<string, { surface: string; ref: string; bytes: number }>();
    const completed = new Set<string>();
    let deleted = 0,
      freedBytes = 0,
      alreadyMissing = 0,
      incomplete = false,
      finished = false;
    let status = 'unknown',
      entries = 0,
      headerSeen = false,
      currentFormat = false;
    /**
     * 将当前审计标为不完整且计划绑定无效，后续展示不能据此声称删除证据完整。
     * EN: Marks the audit incomplete and its plan binding invalid so later views cannot claim complete deletion evidence.
     */
    const invalid = () => {
      incomplete = true;
      binding = { status: 'invalid', reason: 'audit_invalid' };
    };
    const lines = readFileSync(filename, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      /**
       * 即使JSON片段可解析，缺少记录分隔符也可能是撕裂写入。
       * EN: A JSON fragment without the record delimiter may be a torn write, even when it parses.
       */
      if (index === lines.length - 1) {
        invalid();
        break;
      }
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        invalid();
        break;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || finished) {
        invalid();
        break;
      }
      if (entry.type === 'started') {
        if (entries !== 0 || headerSeen) {
          invalid();
          break;
        }
        headerSeen = true;
        if (entry.format === 1) {
          if (binding.reason !== 'plan_invalid') binding = { status: 'unbound', reason: 'legacy_format' };
        } else {
          const parsed = headerSchema.safeParse(entry);
          if (
            !parsed.success ||
            new Set(parsed.data.surfaces.map((item) => item.surface)).size !== parsed.data.surfaces.length
          ) {
            invalid();
            break;
          }
          currentFormat = true;
          if (plan) {
            const { candidates: _, ...expected } = plan;
            const { type: _type, format: _format, createdAt: _createdAt, ...actual } = parsed.data;
            binding =
              stable(expected) === stable(actual)
                ? { status: 'verified' }
                : { status: 'mismatch', reason: 'plan_mismatch' };
          } else if (binding.reason !== 'plan_invalid')
            binding = { status: 'unbound', reason: 'plan_not_provided' };
        }
      } else if (entry.type === 'finished') {
        if (!['completed', 'cancelled', 'failed'].includes(entry.status)) {
          invalid();
          break;
        }
        finished = true;
        status = entry.status;
      } else if (entry.type === 'phase') {
        if (
          !['integrity', 'references', 'candidates', 'preflight', 'delete'].includes(entry.phase) ||
          (entry.surface !== undefined && !['native', 'terminal'].includes(entry.surface))
        ) {
          invalid();
          break;
        }
      } else if (['delete-started', 'delete-completed', 'already-missing'].includes(entry.type)) {
        if (
          !['native', 'terminal'].includes(entry.surface) ||
          typeof entry.ref !== 'string' ||
          !/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(entry.ref) ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 0
        ) {
          invalid();
          break;
        }
        const key = entry.surface + '/' + entry.ref;
        if (
          currentFormat &&
          plan &&
          plan.candidates.get(key) !== entry.bytes &&
          binding.status !== 'mismatch'
        )
          binding = { status: 'mismatch', reason: 'candidate_mismatch' };
        if (completed.has(key)) {
          invalid();
          break;
        }
        if (entry.type === 'delete-started') {
          if (pending.has(key)) {
            invalid();
            break;
          }
          pending.set(key, { surface: entry.surface, ref: entry.ref, bytes: entry.bytes });
        } else if (entry.type === 'delete-completed') {
          const started = pending.get(key);
          if (!started || started.bytes !== entry.bytes) {
            invalid();
            break;
          }
          pending.delete(key);
          completed.add(key);
          deleted++;
          freedBytes += entry.bytes;
        } else {
          if (pending.has(key)) {
            invalid();
            break;
          }
          completed.add(key);
          alreadyMissing++;
        }
      } else {
        invalid();
        break;
      }
      entries++;
    }
    if (!finished || pending.size) incomplete = true;
    if (
      finished &&
      status === 'completed' &&
      (pending.size || (binding.status === 'verified' && plan && completed.size !== plan.candidates.size))
    ) {
      /**
       * 成功页脚不能把未完成或遗漏候选变成已确认结果。
       * EN: A successful footer cannot turn unfinished or omitted candidates into confirmed outcomes.
       */
      invalid();
      status = 'unknown';
    }
    return {
      available: true as const,
      binding,
      deleted,
      freedBytes,
      alreadyMissing,
      unknownInFlight: [...pending.values()],
      incomplete,
      finished,
      status,
    };
  } catch {
    return { available: false as const };
  }
}
