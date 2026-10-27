/** 读取和更新来源备注的处理状态。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import {
  SourceNoteResolutionInput,
  SourceNoteResolutionStatus,
  ReviewSourceNote,
  type DeliveryEvidence,
  type SourceNoteResolution,
  type SourceNoteResolutions,
} from '../../../packages/contracts/src/workflow.js';
import { hash, now, stable, type Store } from '../../../packages/storage/src/index.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const storedSchema = z
  .object({
    revision: z.number().int().positive(),
    sourceHash: digest,
    noteIndex: z.number().int().min(0).max(39),
    status: SourceNoteResolutionStatus,
    note: z.string().max(1000),
    criterionIndex: z.number().int().nonnegative().nullable(),
    criterionText: z.string().nullable(),
    evidence: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          type: z.enum(['file', 'artifact', 'command']),
          ref: z.string(),
          hash: z.string().nullable(),
          note: z.string(),
          artifact: z
            .object({
              id: z.string(),
              name: z.string(),
              version: z.number(),
              hash: z.string(),
              mediaType: z.string(),
              verified: z.boolean(),
            })
            .nullable(),
        }),
      )
      .max(10),
    fingerprint: digest,
    updatedAt: z.string(),
  })
  .strict();
type StoredResolution = z.infer<typeof storedSchema>;
type EvidenceReader = (
  run: Run,
  root: Task,
  criterionIndex: number,
  indices: number[],
) => (DeliveryEvidence & { index: number })[];

function conflict(code: string, message: string): never {
  throw new AppError(code, message, false, null, 409);
}
function sourceState(store: Store, runId: string, known?: { run: Run; root: Task; fingerprint: string }) {
  const run = known?.run ?? store.require<Run>('runs', runId),
    root = known?.root ?? store.require<Task>('tasks', run.rootTaskId);
  invariant(
    (run.execution?.kind ?? 'native') === 'native' && root.runId === run.id,
    'SOURCE_RESOLUTION_SCOPE',
    '来源复验仅支持原生任务',
  );
  if (run.source) {
    // Keep historical snapshot hashing exact: never add new optional defaults before verification.
    const { hash: expected, ...snapshot } = run.source;
    invariant(
      hash(stable(snapshot)) === expected,
      'SOURCE_SNAPSHOT_INVALID',
      '来源快照完整性核验失败，请修复记录后重试',
    );
  }
  const notes = (run.source?.reviewNotes ?? []).map((note) => ReviewSourceNote.parse(note));
  invariant(notes.length <= 40, 'SOURCE_RESOLUTION_SCOPE', '来源备注数量无效');
  const fingerprint = known?.fingerprint ?? deliveryFingerprint(store, run, root);
  const project = run.projectId
    ? store.get<{ id: string; revision: number; archived: boolean }>('projects', run.projectId)
    : undefined;
  const writable =
    run.kind === 'task' &&
    !!project &&
    !project.archived &&
    !run.archived &&
    run.status === 'DONE' &&
    root.status === 'DONE' &&
    notes.length > 0;
  return { run, root, notes, fingerprint, writable };
}
function rowResolution(
  store: Store,
  runId: string,
  sourceHash: string,
  noteIndex: number,
): StoredResolution | undefined {
  const row = store.db
    .prepare(
      'SELECT revision,data FROM source_note_resolutions_v1 WHERE run_id=? AND source_hash=? AND note_index=?',
    )
    .get(runId, sourceHash, noteIndex) as { revision: number; data: string } | undefined;
  if (!row) return;
  try {
    const value = storedSchema.parse(JSON.parse(row.data));
    if (value.revision !== row.revision || value.sourceHash !== sourceHash || value.noteIndex !== noteIndex)
      throw Error('Resolution identity');
    return value;
  } catch {
    throw new AppError(
      'SOURCE_RESOLUTION_UNREADABLE',
      '来源复验记录暂时无法读取，请修复记录后重试',
      true,
      null,
      422,
    );
  }
}
function view(store: Store, state: ReturnType<typeof sourceState>): SourceNoteResolutions {
  const { run, root, notes, fingerprint, writable } = state;
  return {
    runId: run.id,
    runRevision: run.revision,
    rootRevision: root.revision,
    currentFingerprint: fingerprint,
    sourceHash: run.source?.hash ?? null,
    writable,
    items: notes.map((sourceNote, noteIndex) => {
      const stored = rowResolution(store, run.id, run.source!.hash, noteIndex);
      let resolution: SourceNoteResolution | null = null;
      if (stored) {
        const { sourceHash: _hash, noteIndex: _index, ...fields } = stored;
        resolution = { ...fields, stale: stored.fingerprint !== fingerprint };
      }
      return { noteIndex, sourceNote, resolution };
    }),
  };
}
/** 根据运行、根任务和当前交付指纹生成来源备注处理状态。 */
export function sourceNoteResolutionsFor(store: Store, run: Run, root: Task, fingerprint: string) {
  return view(store, sourceState(store, run.id, { run, root, fingerprint }));
}
/** Manual follow-up conclusions are independent of execution and saved acceptance decisions. */
/**
 * 保存用户对来源意见的逐项复验，绑定来源快照、当前交付指纹和复验记录自己的版本。
 * 证据只能来自手工选定的当前验收项；交付变化后旧结论显示 stale，不自动宣告继续有效。
 * “已解决”是独立人工结论，不修改执行状态或替代已保存的验收决定。
 */
export function registerSourceNoteResolutions(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string) => void,
  readEvidence: EvidenceReader,
) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS source_note_resolutions_v1(
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,note_index INTEGER NOT NULL,revision INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(run_id,source_hash,note_index)
  );`);
  app.get<{ Params: { id: string } }>('/api/runs/:id/source-note-resolutions', (request) => {
    z.object({}).strict().parse(request.query);
    return store.tx(() => view(store, sourceState(store, request.params.id)));
  });
  app.put<{ Params: { id: string } }>('/api/runs/:id/source-note-resolutions', (request) => {
    const body = SourceNoteResolutionInput.parse(request.body);
    return store.command(
      body.commandId,
      { route: `/runs/${request.params.id}/source-note-resolutions`, body },
      () => {
        const state = sourceState(store, request.params.id),
          { run, root, fingerprint } = state;
        assertMutable(run.id, run.projectId ?? undefined);
        invariant(
          state.writable,
          'SOURCE_RESOLUTION_NOT_DONE',
          '只有已交付且未归档的原生项目修订任务可以保存来源复验',
        );
        if (body.expectedRevision !== run.revision || body.expectedRootRevision !== root.revision)
          conflict('REVISION_CONFLICT', '任务版本已变化，请重新读取后复验');
        if (body.sourceHash !== run.source?.hash) conflict('SOURCE_CHANGED', '来源快照已变化，请重新读取');
        if (body.expectedFingerprint !== fingerprint)
          conflict('DELIVERY_CHANGED', '当前交付已变化，请重新读取并确认复验关联');
        invariant(body.noteIndex < state.notes.length, 'SOURCE_NOTE_SCOPE', '所选备注不属于当前任务来源快照');
        const previous = rowResolution(store, run.id, body.sourceHash, body.noteIndex);
        if ((previous?.revision ?? 0) !== body.expectedResolutionRevision)
          conflict('SOURCE_RESOLUTION_CONFLICT', '此备注复验已被更新，请保留输入并重新读取');
        invariant(
          body.status === 'pending' || !!body.note.trim(),
          'SOURCE_RESOLUTION_NOTE',
          '已解决或仍需修改须填写人工说明',
        );
        invariant(
          body.criterionIndex === null || body.criterionIndex < root.spec.acceptanceCriteria.length,
          'CRITERION_SCOPE',
          '所选标准不属于当前交付',
        );
        invariant(
          new Set(body.evidenceIndices).size === body.evidenceIndices.length &&
            (!body.evidenceIndices.length || body.criterionIndex !== null),
          'SOURCE_EVIDENCE_SCOPE',
          '证据必须属于手工选定的当前标准，且不能重复',
        );
        const evidence =
          body.criterionIndex === null
            ? []
            : readEvidence(run, root, body.criterionIndex, body.evidenceIndices);
        const stored: StoredResolution = {
          revision: (previous?.revision ?? 0) + 1,
          sourceHash: body.sourceHash,
          noteIndex: body.noteIndex,
          status: body.status,
          note: body.note,
          criterionIndex: body.criterionIndex,
          criterionText:
            body.criterionIndex === null ? null : root.spec.acceptanceCriteria[body.criterionIndex],
          evidence,
          fingerprint,
          updatedAt: now(),
        };
        const json = stable(stored),
          bytes = Buffer.byteLength(json, 'utf8');
        invariant(
          bytes <= 32 * 1024,
          'SOURCE_RESOLUTION_LIMIT',
          '此项复验快照超过 32 KiB，请减少证据选择；内容不会自动截断',
        );
        const total = Number(
          (
            store.db
              .prepare(
                'SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) bytes FROM source_note_resolutions_v1 WHERE run_id=? AND source_hash=? AND note_index<>?',
              )
              .get(run.id, body.sourceHash, body.noteIndex) as { bytes: number }
          ).bytes,
        );
        invariant(
          total + bytes <= 128 * 1024,
          'SOURCE_RESOLUTION_TOTAL_LIMIT',
          '来源复验快照合计超过 128 KiB，请减少说明或证据选择；内容不会自动截断',
        );
        store.db
          .prepare(
            `INSERT INTO source_note_resolutions_v1(run_id,source_hash,note_index,revision,data) VALUES(?,?,?,?,?)
        ON CONFLICT(run_id,source_hash,note_index) DO UPDATE SET revision=excluded.revision,data=excluded.data`,
          )
          .run(run.id, body.sourceHash, body.noteIndex, stored.revision, json);
        store.event(run.id, 'run.source_notes.updated', {
          noteIndex: body.noteIndex,
          revision: stored.revision,
        });
        return view(store, state);
      },
    );
  });
}
