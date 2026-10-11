import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type {
  DeliveryReviewStatus,
  DeliveryReviewSummary,
} from '../../../packages/contracts/src/workflow.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';

type Row = {
  review_status: DeliveryReviewStatus | null;
  reviewed_at: string | null;
  issue_code: string | null;
};
const unreadable = {
  code: 'DELIVERY_UNREADABLE' as const,
  message: '交付记录暂时无法读取，复核结论未知。可修复记录后重试。',
  retryable: true as const,
};
type Projection = {
  deliveryProjectionVersion?: number;
  deliveryReview?: Pick<NonNullable<Run['deliveryReview']>, 'decision' | 'fingerprint' | 'reviewedAt'> | null;
  readModel?: Pick<Run, 'id' | 'kind' | 'status' | 'projectId' | 'rootTaskId' | 'execution'>;
};
const rootId = (alias: string) =>
  `COALESCE(json_extract(${alias ? alias + '.' : ''}data,'$.readModel.rootTaskId'),json_extract(${alias ? alias + '.' : ''}data,'$.rootTaskId'))`;

/** Rebuildable index. Triggers invalidate inside the source write transaction; reads drain all dirty batches. */
export class DeliveryReviewReads {
  private warming?: Promise<void>;
  constructor(private store: Store) {
    store.tx(() => {
      store.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_review_summary_v1(
        run_id TEXT PRIMARY KEY,review_status TEXT,reviewed_at TEXT,dirty INTEGER NOT NULL DEFAULT 1,issue_code TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_review_dirty ON delivery_review_summary_v1(dirty,run_id);
      CREATE INDEX IF NOT EXISTS delivery_review_status ON delivery_review_summary_v1(review_status,run_id);
      CREATE INDEX IF NOT EXISTS delivery_review_root ON runs(${rootId('')});
      INSERT OR IGNORE INTO delivery_review_summary_v1(run_id) SELECT id FROM runs;
    `);
      const columns = store.db.prepare('PRAGMA table_info(delivery_review_summary_v1)').all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === 'issue_code'))
        store.db.exec('ALTER TABLE delivery_review_summary_v1 ADD COLUMN issue_code TEXT');
      store.db.exec(
        'CREATE INDEX IF NOT EXISTS delivery_review_issue ON delivery_review_summary_v1(issue_code,run_id)',
      );
      const dirty = (query: string) => `INSERT INTO delivery_review_summary_v1(run_id,dirty) ${query}
      ON CONFLICT(run_id) DO UPDATE SET dirty=1;`;
      for (const table of ['runs', 'tasks', 'artifacts']) {
        const query = (alias: 'NEW' | 'OLD') =>
          table === 'runs'
            ? `SELECT id,1 FROM runs WHERE id=${alias}.id`
            : table === 'tasks'
              ? `SELECT r.id,1 FROM runs r WHERE ${rootId('r')}=${alias}.id`
              : `SELECT id,1 FROM runs WHERE id=${alias}.run_id`;
        const field = (alias: string, name: string) => `json_extract(${alias}.data,'$.${name}')`;
        const changed =
          table === 'runs'
            ? [
                'readModel.kind',
                'readModel.status',
                'readModel.projectId',
                'readModel.rootTaskId',
                'readModel.execution.kind',
                'deliveryProjectionVersion',
                'deliveryReview',
              ]
                .map((name) => `${field('NEW', name)} IS NOT ${field('OLD', name)}`)
                .join(' OR ') +
              ` OR json_type(NEW.data,'$.readModel') IS NOT 'object' OR ${field('NEW', 'deliveryProjectionVersion')} IS NOT 1`
            : `NEW.run_id IS NOT OLD.run_id OR ${field('NEW', 'deliverySemanticHash')} IS NOT ${field('OLD', 'deliverySemanticHash')}
          OR ${field('NEW', 'deliverySemanticHash')} IS NULL OR ${field('OLD', 'deliverySemanticHash')} IS NULL`;
        const failed = (
          alias: 'NEW' | 'OLD',
        ) => `EXISTS(SELECT 1 FROM delivery_review_summary_v1 d WHERE d.issue_code IS NOT NULL
        AND d.run_id IN (${query(alias).replace(',1 FROM', ' FROM')}))`;
        store.db.exec(`
        CREATE TRIGGER IF NOT EXISTS delivery_review_${table}_insert AFTER INSERT ON ${table}
        BEGIN ${dirty(query('NEW'))} END;
        DROP TRIGGER IF EXISTS delivery_review_${table}_update;
        CREATE TRIGGER delivery_review_${table}_update AFTER UPDATE ON ${table}
        WHEN ${changed} OR (NEW.revision IS OLD.revision AND NEW.content IS NOT OLD.content)
          OR ${failed('OLD')} OR ${failed('NEW')}
        BEGIN ${dirty(query('OLD'))} ${dirty(query('NEW'))} END;
        CREATE TRIGGER IF NOT EXISTS delivery_review_${table}_delete AFTER DELETE ON ${table}
        BEGIN ${table === 'runs' ? 'DELETE FROM delivery_review_summary_v1 WHERE run_id=OLD.id;' : dirty(query('OLD'))} END;
      `);
      }
    });
  }
  cached(runId: string): DeliveryReviewSummary {
    const row = this.store.db
      .prepare('SELECT review_status,reviewed_at,issue_code FROM delivery_review_summary_v1 WHERE run_id=?')
      .get(runId) as Row | undefined;
    return {
      runId,
      reviewStatus: row?.review_status ?? null,
      reviewedAt: row?.reviewed_at ?? null,
      ...(row?.issue_code ? { reviewIssue: unreadable } : {}),
    };
  }
  retryFailures(runId?: string) {
    this.store.db
      .prepare(
        `UPDATE delivery_review_summary_v1 SET dirty=1 WHERE issue_code IS NOT NULL${runId ? ' AND run_id=?' : ''}`,
      )
      .run(...(runId ? [runId] : []));
  }
  private refreshSafely(runId: string) {
    this.store.db.exec('SAVEPOINT delivery_review_item');
    try {
      this.refresh(runId);
      this.store.db.exec('RELEASE delivery_review_item');
    } catch (error) {
      this.store.db.exec('ROLLBACK TO delivery_review_item; RELEASE delivery_review_item');
      // Database/transaction failures affect the whole read, not a single delivery record.
      if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') throw error;
      this.store.db
        .prepare(
          'UPDATE delivery_review_summary_v1 SET review_status=NULL,reviewed_at=NULL,issue_code=?,dirty=0 WHERE run_id=?',
        )
        .run(unreadable.code, runId);
    }
  }
  private refresh(runId: string) {
    const row = this.store.db.prepare('SELECT data FROM runs WHERE id=?').get(runId) as
      | { data: string }
      | undefined;
    if (!row) {
      this.store.db.prepare('DELETE FROM delivery_review_summary_v1 WHERE run_id=?').run(runId);
      return;
    }
    let projection = JSON.parse(row.data) as Projection;
    const eligible = (run: Projection['readModel']) =>
      !!run &&
      run.kind === 'task' &&
      run.status === 'DONE' &&
      !!run.projectId &&
      (run.execution?.kind ?? 'native') === 'native';
    // Legacy summaries lack review metadata. Hydrate only potentially eligible records once.
    if (
      !projection.readModel ||
      (eligible(projection.readModel) && projection.deliveryProjectionVersion !== 1)
    ) {
      const run = this.store.require<Run>('runs', runId);
      this.store.refreshReadProjection('runs', run);
      projection = { readModel: run, deliveryProjectionVersion: 1, deliveryReview: run.deliveryReview };
    }
    let status: DeliveryReviewStatus | null = null;
    let reviewedAt: string | null = null;
    if (eligible(projection.readModel)) {
      const review = projection.deliveryReview;
      status = 'unreviewed';
      if (review) {
        const root = this.store.get<Task>('tasks', projection.readModel!.rootTaskId);
        if (
          root &&
          !this.store.db
            .prepare(
              "SELECT 1 FROM tasks WHERE id=? AND json_extract(data,'$.deliverySemanticHash') IS NOT NULL",
            )
            .get(root.id)
        )
          this.store.refreshReadProjection('tasks', root);
        status =
          root &&
          root.runId === runId &&
          review.fingerprint === deliveryFingerprint(this.store, { id: runId }, root)
            ? review.decision
            : 'stale';
        reviewedAt = review.reviewedAt;
      }
    }
    this.store.db
      .prepare(
        'UPDATE delivery_review_summary_v1 SET review_status=?,reviewed_at=?,dirty=0,issue_code=NULL WHERE run_id=?',
      )
      .run(status, reviewedAt, runId);
  }
  async ensure(runId?: string) {
    if (runId) {
      if (
        this.store.db
          .prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE run_id=? AND dirty=1')
          .get(runId)
      )
        this.store.tx(() => this.refreshSafely(runId));
      return;
    }
    if (this.warming) return this.warming;
    const pending = this.batches();
    this.warming = pending;
    try {
      await pending;
    } finally {
      if (this.warming === pending) this.warming = undefined;
    }
  }
  /** Publish a coherent snapshot even when another writer dirties a summary during an await. */
  async read<T>(read: () => T, runId?: string): Promise<T> {
    for (;;) {
      await this.ensure(runId);
      const result = this.store.tx(() => {
        const dirty = runId
          ? this.store.db
              .prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE run_id=? AND dirty=1')
              .get(runId)
          : this.store.db.prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE dirty=1 LIMIT 1').get();
        return dirty ? { ready: false as const } : { ready: true as const, value: read() };
      });
      if (result.ready) return result.value;
    }
  }
  private async batches() {
    for (;;) {
      const rows = this.store.db
        .prepare('SELECT run_id FROM delivery_review_summary_v1 WHERE dirty=1 ORDER BY run_id LIMIT 32')
        .all() as { run_id: string }[];
      if (!rows.length) return;
      this.store.tx(() => {
        for (const { run_id } of rows) this.refreshSafely(run_id);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
const instances = new WeakMap<Store, DeliveryReviewReads>();
export function deliveryReviewReads(store: Store) {
  let instance = instances.get(store);
  if (!instance) {
    instance = new DeliveryReviewReads(store);
    instances.set(store, instance);
  }
  return instance;
}
