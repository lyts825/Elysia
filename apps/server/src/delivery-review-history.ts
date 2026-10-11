import { AppError, type Run, type Task } from '../../../packages/contracts/src/index.js';
import { z } from 'zod';
import type {
  DeliveryChangeSummary,
  DeliveryReviewHistory,
  DeliveryReviewHistoryDetail,
  DeliveryReviewHistoryItem,
  DeliveryUserReview,
} from '../../../packages/contracts/src/workflow.js';
import { hash, id, stable, type Store } from '../../../packages/storage/src/index.js';
import { deliveryArtifactMetadata, deliveryFingerprintFromArtifacts } from './delivery-fingerprint.js';

type Baseline = {
  version: 1;
  fingerprint: string;
  rootTaskId: string;
  status: string;
  deliverablesHash: string;
  deliverablesCount: number;
  criteriaHash: string;
  criteriaCount: number;
  resultHash: string;
  artifacts: ReturnType<typeof deliveryArtifactMetadata>;
};
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.object({
  version: z.literal(1),
  fingerprint: digest,
  rootTaskId: z.string().min(1),
  status: z.string().min(1),
  deliverablesHash: digest,
  deliverablesCount: z.number().int().nonnegative(),
  criteriaHash: digest,
  criteriaCount: z.number().int().nonnegative(),
  resultHash: digest,
  artifacts: z
    .array(
      z.object({
        id: z.string().min(1),
        taskId: z.string().min(1),
        name: z.string(),
        version: z.number().int().nonnegative(),
        hash: digest,
        mediaType: z.string(),
        verified: z.boolean(),
      }),
    )
    .refine((items) => new Set(items.map((artifact) => artifact.id)).size === items.length),
});
/** Stored comparison metadata may come from older or damaged records; never infer a comparison from it. */
function readBaseline(raw: string): Baseline | undefined {
  try {
    const parsed = baselineSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
type HistoryRow = {
  id: string;
  decision: DeliveryUserReview['decision'];
  reviewed_at: string;
  fingerprint: string;
  note_preview: string;
  criteria_notes_count: number;
  origin: DeliveryReviewHistoryItem['origin'];
  baseline_available: number;
};
const itemColumns =
  'id,decision,reviewed_at,fingerprint,note_preview,criteria_notes_count,origin,baseline_json IS NOT NULL AS baseline_available';
const item = (row: HistoryRow): DeliveryReviewHistoryItem => ({
  id: row.id,
  decision: row.decision,
  reviewedAt: row.reviewed_at,
  fingerprint: row.fingerprint,
  notePreview: row.note_preview,
  criteriaNotesCount: row.criteria_notes_count,
  origin: row.origin,
  baselineAvailable: !!row.baseline_available,
});
const reviewHash = ({ reviewId: _reviewId, ...review }: DeliveryUserReview) => hash(stable(review));

/** Authoritative review snapshots, independent of large run.updated events and binary object retention. */
export function initializeDeliveryReviewHistory(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_review_history_v1(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      review_hash TEXT NOT NULL,decision TEXT NOT NULL,reviewed_at TEXT NOT NULL,fingerprint TEXT NOT NULL,
      note_preview TEXT NOT NULL,criteria_notes_count INTEGER NOT NULL,origin TEXT NOT NULL,
      review_json TEXT NOT NULL CHECK(json_valid(review_json)),
      baseline_json TEXT CHECK(baseline_json IS NULL OR json_valid(baseline_json))
    );
    CREATE INDEX IF NOT EXISTS delivery_review_history_run ON delivery_review_history_v1(run_id);
  `);
}
export function captureDeliveryBaseline(store: Store, run: Run, root: Task): Baseline {
  const artifacts = deliveryArtifactMetadata(store, run.id);
  return {
    version: 1,
    fingerprint: deliveryFingerprintFromArtifacts(run, root, artifacts),
    rootTaskId: root.id,
    status: root.status,
    deliverablesHash: hash(stable(root.spec.deliverables)),
    deliverablesCount: root.spec.deliverables.length,
    criteriaHash: hash(stable(root.spec.acceptanceCriteria)),
    criteriaCount: root.spec.acceptanceCriteria.length,
    resultHash: hash(stable(root.result ?? null)),
    artifacts,
  };
}
export function appendDeliveryReview(
  store: Store,
  runId: string,
  review: DeliveryUserReview,
  baseline: Baseline | null,
  origin: DeliveryReviewHistoryItem['origin'] = 'saved',
): DeliveryUserReview {
  const snapshot = { ...review, reviewId: review.reviewId ?? id() };
  store.db
    .prepare(
      `INSERT INTO delivery_review_history_v1(
    id,run_id,review_hash,decision,reviewed_at,fingerprint,note_preview,criteria_notes_count,origin,review_json,baseline_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      snapshot.reviewId,
      runId,
      reviewHash(snapshot),
      snapshot.decision,
      snapshot.reviewedAt,
      snapshot.fingerprint,
      snapshot.note.slice(0, 400),
      snapshot.criteriaNotes.length,
      origin,
      stable(snapshot),
      baseline ? stable(baseline) : null,
    );
  return snapshot;
}
/** Only the currently surviving old review can be imported; earlier ordinary events are not reconstructed. */
export function ensureCurrentReviewSnapshot(store: Store, run: Run): string | undefined {
  if (!run.deliveryReview) return;
  return store.tx(() => {
    const latest = store.db
      .prepare(
        'SELECT id,review_hash FROM delivery_review_history_v1 WHERE run_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(run.id) as { id: string; review_hash: string } | undefined;
    if (latest?.review_hash === reviewHash(run.deliveryReview!)) return latest.id;
    return appendDeliveryReview(
      store,
      run.id,
      { ...run.deliveryReview!, reviewId: id() },
      null,
      'legacy_snapshot',
    ).reviewId;
  });
}
/** Read only: strict run ownership; never import or mutate a source while validating a selection. */
export function savedReviewSnapshot(
  store: Store,
  runId: string,
  reviewId: string,
): DeliveryUserReview | undefined {
  if (
    !store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_review_history_v1'")
      .get()
  )
    return;
  const row = store.db
    .prepare('SELECT review_json FROM delivery_review_history_v1 WHERE run_id=? AND id=?')
    .get(runId, reviewId) as { review_json: string } | undefined;
  return row ? (JSON.parse(row.review_json) as DeliveryUserReview) : undefined;
}
const unknown = (
  reason: 'baseline_missing' | 'baseline_invalid' | 'current_unreadable',
  baseline: 'known' | 'unknown',
): DeliveryChangeSummary => ({
  baseline,
  status: 'unknown',
  reason,
  fields: null,
  artifacts: null,
});
export function deliveryChanges(
  store: Store,
  runId: string,
  reviewId: string,
  current: Baseline | null,
): DeliveryChangeSummary {
  const row = store.db
    .prepare('SELECT baseline_json,fingerprint FROM delivery_review_history_v1 WHERE run_id=? AND id=?')
    .get(runId, reviewId) as { baseline_json: string | null; fingerprint: string } | undefined;
  if (!row?.baseline_json) return unknown('baseline_missing', 'unknown');
  const before = readBaseline(row.baseline_json);
  if (!before || before.fingerprint !== row.fingerprint) return unknown('baseline_invalid', 'unknown');
  if (!current) return unknown('current_unreadable', 'known');
  const previous = new Map(before.artifacts.map((artifact) => [artifact.id, artifact]));
  let added = 0,
    changed = 0;
  for (const artifact of current.artifacts) {
    const prior = previous.get(artifact.id);
    if (!prior) added++;
    else if (stable(prior) !== stable(artifact)) changed++;
    previous.delete(artifact.id);
  }
  const fields = {
    root: before.rootTaskId !== current.rootTaskId,
    status: before.status !== current.status,
    deliverables: before.deliverablesHash !== current.deliverablesHash,
    criteria: before.criteriaHash !== current.criteriaHash,
    result: before.resultHash !== current.resultHash,
  };
  const artifacts = { added, removed: previous.size, changed };
  const unchanged = before.fingerprint === current.fingerprint;
  if (unchanged && (Object.values(fields).some(Boolean) || Object.values(artifacts).some(Boolean)))
    return unknown('baseline_invalid', 'unknown');
  return { baseline: 'known', status: unchanged ? 'unchanged' : 'changed', fields, artifacts };
}
export function deliveryReviewHistory(store: Store, run: Run, before?: string): DeliveryReviewHistory {
  ensureCurrentReviewSnapshot(store, run);
  const limit = 20;
  let position: number | undefined;
  if (before) {
    const cursor = store.db
      .prepare('SELECT rowid position FROM delivery_review_history_v1 WHERE run_id=? AND id=?')
      .get(run.id, before) as { position: number } | undefined;
    if (!cursor) throw new AppError('PAGE_CURSOR', '复核历史位置已失效，请返回首页', false, null, 409);
    position = cursor.position;
  }
  const rows = store.db
    .prepare(
      `SELECT ${itemColumns} FROM delivery_review_history_v1 WHERE run_id=?${position === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(run.id, ...(position === undefined ? [] : [position]), limit + 1) as HistoryRow[];
  const counts = store.db
    .prepare(
      "SELECT COUNT(*) total,COALESCE(SUM(origin='legacy_snapshot'),0) legacy_count FROM delivery_review_history_v1 WHERE run_id=?",
    )
    .get(run.id) as { total: number; legacy_count: number };
  const selected = rows.slice(0, limit),
    hasMore = rows.length > limit;
  return {
    runId: run.id,
    items: selected.map(item),
    page: {
      limit,
      before: before ?? null,
      total: counts.total,
      hasMore,
      nextBefore: hasMore ? selected.at(-1)!.id : null,
    },
    coverage: {
      sinceVersion: '0.27.0-preview.1',
      possibleGaps: counts.legacy_count > 0,
      legacyCount: counts.legacy_count,
    },
  };
}
export function deliveryReviewHistoryDetail(
  store: Store,
  run: Run,
  reviewId: string,
): DeliveryReviewHistoryDetail {
  ensureCurrentReviewSnapshot(store, run);
  const row = store.db
    .prepare(`SELECT ${itemColumns},review_json FROM delivery_review_history_v1 WHERE run_id=? AND id=?`)
    .get(run.id, reviewId) as (HistoryRow & { review_json: string }) | undefined;
  if (!row) throw new AppError('NOT_FOUND', '复核历史不存在', false, null, 404);
  let current: Baseline | null = null,
    root: Task | undefined;
  try {
    root = store.get<Task>('tasks', run.rootTaskId);
    if (root?.runId === run.id) current = captureDeliveryBaseline(store, run, root);
  } catch (error) {
    if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') throw error;
  }
  return {
    runId: run.id,
    item: item(row),
    review: JSON.parse(row.review_json),
    changeSummary: deliveryChanges(store, run.id, reviewId, current),
    currentFingerprint: current?.fingerprint ?? null,
    runRevision: run.revision,
    rootRevision: root?.revision ?? null,
  };
}
