/**
 * 保存阶段游标、领取序号、等待边和预算累计。事务由 Store 统一管理。
 * EN: Persists stage cursors, fencing, wait edges and incremental budgets under Store transactions.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from './index.js';
import {
  AppError,
  type Task,
  type Run,
  type RequestRecord,
  type Agent,
  type Operation,
  type Artifact,
  type Snapshot,
} from '../../contracts/src/index.js';
import type {
  BudgetTotal,
  NativeStage,
  SchedulingIndex,
  WorkLease,
} from '../../contracts/src/async-scheduling.js';
import { StatementCache } from './statement-cache.js';

export class AsyncScheduling implements SchedulingIndex {
  private statements: StatementCache;
  private migrating = false;
  constructor(private store: Store) {
    this.statements = new StatementCache(store.db);
  }
  private get db() {
    return this.store.db;
  }
  private prepare(sql: string) {
    return this.statements.prepare(sql);
  }
  /** 旧记录缺失执行字段时保留原文并停止该运行；索引不能把未知预算当成零。 */
  private unreadable(table: string, key: string, runId: string) {
    if (!this.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) return;
    // 普通投影夹具或未装配的记录没有执行配置；升级已有数据时仍登记恢复问题。
    // EN: Incomplete non-executable records have no runtime configuration; migration still records recovery issues.
    if (!this.migrating && !this.store.get<Run>('runs', runId)?.limits) return;
    this.prepare("INSERT OR IGNORE INTO execution_holds_v1 VALUES(?,'recovery_unreadable',?)").run(
      runId,
      new Date().toISOString(),
    );
    this.prepare('INSERT OR IGNORE INTO execution_recovery_issues_v1 VALUES(?,?,?)').run(table, key, runId);
  }

  initialize(decode: (bytes: Uint8Array) => any) {
    this.migrating = true;
    this.db.exec(`
      CREATE TABLE async_clock_v1(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL);
      INSERT INTO async_clock_v1 VALUES(1,0);
      CREATE TABLE async_runs_v1(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,scan_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE async_work_v1(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,parent_id TEXT,agent_id TEXT NOT NULL,
        task_key TEXT NOT NULL,role TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,wait_reason TEXT,
        ready_at REAL NOT NULL DEFAULT 0,queue_seq INTEGER NOT NULL,stage TEXT NOT NULL DEFAULT 'model',
        message_id TEXT,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,lease_until REAL,required INTEGER NOT NULL,needs_decision INTEGER NOT NULL);
      CREATE INDEX async_ready_v1 ON async_work_v1(run_id,status,queue_seq);
      CREATE INDEX async_due_v1 ON async_work_v1(run_id,status,wait_reason,ready_at);
      CREATE INDEX async_parent_v1 ON async_work_v1(run_id,parent_id,task_id);
      CREATE INDEX async_children_v1 ON async_work_v1(parent_id,task_id);
      CREATE INDEX async_key_v1 ON async_work_v1(run_id,task_key);
      CREATE INDEX async_role_v1 ON async_work_v1(run_id,role,model);
      CREATE TABLE async_edges_v1(source TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,
        PRIMARY KEY(source,target,kind));
      CREATE INDEX async_edge_target_v1 ON async_edges_v1(target,kind,source);
      CREATE TABLE async_wait_groups_v1(parent_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,total INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,decisions INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX async_wait_ready_v1 ON async_wait_groups_v1(parent_id) WHERE pending=0 OR decisions>0;
      CREATE TRIGGER async_wait_added_v1 AFTER INSERT ON async_edges_v1 WHEN NEW.kind='wait' BEGIN
        UPDATE async_wait_groups_v1 SET total=total+1,
          pending=pending+COALESCE((SELECT status NOT IN ('DONE','FAILED','CANCELLED') FROM async_work_v1 WHERE task_id=NEW.target),1),
          decisions=decisions+COALESCE((SELECT needs_decision FROM async_work_v1 WHERE task_id=NEW.target),0) WHERE parent_id=NEW.source;
      END;
      CREATE TRIGGER async_wait_removed_v1 AFTER DELETE ON async_edges_v1 WHEN OLD.kind='wait' BEGIN
        UPDATE async_wait_groups_v1 SET total=total-1,
          pending=pending-COALESCE((SELECT status NOT IN ('DONE','FAILED','CANCELLED') FROM async_work_v1 WHERE task_id=OLD.target),1),
          decisions=decisions-COALESCE((SELECT needs_decision FROM async_work_v1 WHERE task_id=OLD.target),0) WHERE parent_id=OLD.source;
      END;
      CREATE TRIGGER async_wait_changed_v1 AFTER UPDATE OF status,needs_decision ON async_work_v1
      WHEN NEW.status IS NOT OLD.status OR NEW.needs_decision!=OLD.needs_decision BEGIN
        UPDATE async_wait_groups_v1 SET
          pending=pending+(NEW.status NOT IN ('DONE','FAILED','CANCELLED'))-(OLD.status NOT IN ('DONE','FAILED','CANCELLED')),
          decisions=decisions+NEW.needs_decision-OLD.needs_decision
          WHERE parent_id IN (SELECT source FROM async_edges_v1 WHERE target=NEW.task_id AND kind='wait');
      END;
      CREATE TABLE async_operations_v1(operation_id TEXT PRIMARY KEY REFERENCES tool_operations(id) ON DELETE CASCADE,task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL);
      CREATE INDEX async_operation_task_v1 ON async_operations_v1(task_id,name,status);
      CREATE INDEX async_operation_attempt_v1 ON async_operations_v1(task_id,attempt_id,status);
      CREATE TABLE async_artifacts_v1(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,run_id TEXT NOT NULL,task_id TEXT NOT NULL,verified INTEGER NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE INDEX async_artifact_run_v1 ON async_artifacts_v1(run_id,artifact_id);
      CREATE INDEX async_artifact_task_v1 ON async_artifacts_v1(task_id,name);
      CREATE TABLE async_snapshots_v1(snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,run_id TEXT NOT NULL,task_id TEXT NOT NULL,source TEXT NOT NULL);
      CREATE INDEX async_snapshot_task_v1 ON async_snapshots_v1(run_id,task_id);
      CREATE INDEX async_snapshot_source_v1 ON async_snapshots_v1(run_id,source);
      CREATE TABLE async_dirty_v1(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TABLE async_request_budget_v1(request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,currency TEXT NOT NULL,tokens REAL NOT NULL,cost REAL NOT NULL);
      CREATE TABLE async_budget_v1(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        currency TEXT NOT NULL,requests INTEGER NOT NULL,tokens REAL NOT NULL,cost REAL NOT NULL,
        PRIMARY KEY(task_id,currency));
      CREATE TRIGGER async_request_deleted_v1 BEFORE DELETE ON async_request_budget_v1 BEGIN
        UPDATE async_budget_v1 SET requests=requests-1,tokens=tokens-OLD.tokens,cost=cost-OLD.cost
          WHERE currency=OLD.currency AND task_id IN (
            WITH RECURSIVE chain(id,parent) AS (
              SELECT task_id,parent_id FROM async_work_v1 WHERE task_id=OLD.task_id
              UNION SELECT w.task_id,w.parent_id FROM async_work_v1 w JOIN chain c ON w.task_id=c.parent
            ) SELECT id FROM chain
          );
      END;
      CREATE INDEX async_attempt_task_v1 ON attempts(run_id,json_extract(data,'$.taskId'),json_extract(data,'$.status'));
    `);
    const rows = (table: string) =>
      this.prepare(`SELECT id,run_id,data,content FROM ${table}`).iterate() as Iterable<{
        id: string;
        run_id: string;
        data: string;
        content: Uint8Array;
      }>;
    const entity = (row: { data: string; content: Uint8Array }) =>
      row.content ? decode(row.content) : JSON.parse(row.data);
    const visit = (table: string, write: (value: any) => void) => {
      for (const row of rows(table)) {
        let value: any;
        try {
          value = entity(row);
        } catch {
          this.unreadable(table, row.id, table === 'runs' ? row.id : row.run_id);
          continue;
        }
        write(value);
      }
    };
    visit('runs', (value) => this.writeRun(value));
    visit('tasks', (value) => this.writeTask(value));
    // 两端任务先建索引，再恢复等待关系；冻结配置及权威正文不改写。
    visit('tasks', (value) => this.writeWaits(value));
    for (const row of this.prepare('SELECT task_id,dependency_id FROM task_edges').iterate() as Iterable<any>)
      this.addDependency(row.task_id, row.dependency_id);
    visit('requests', (value) => this.writeRequest(value));
    visit('tool_operations', (value) => this.writeOperation(value));
    visit('agents', (value) => this.writeAgent(value));
    visit('artifacts', (value) => this.writeArtifact(value));
    visit('snapshots', (value) => this.writeSnapshot(value));
    this.migrating = false;
  }

  writeArtifact(artifact: Artifact) {
    this.prepare(
      `INSERT INTO async_artifacts_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET run_id=excluded.run_id,task_id=excluded.task_id,verified=excluded.verified,name=excluded.name,hash=excluded.hash`,
    ).run(
      artifact.id,
      artifact.runId,
      artifact.taskId,
      artifact.verified ? 1 : 0,
      artifact.name,
      artifact.hash,
    );
  }
  writeSnapshot(snapshot: Snapshot) {
    this.prepare(
      `INSERT INTO async_snapshots_v1 VALUES(?,?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET run_id=excluded.run_id,task_id=excluded.task_id,source=excluded.source`,
    ).run(snapshot.id, snapshot.runId, snapshot.taskId, snapshot.source);
  }
  snapshotIds(runId: string, options: { taskId?: string; source?: string; extraIds?: string[] } = {}) {
    return (
      this.prepare(
        `SELECT snapshot_id FROM async_snapshots_v1 WHERE run_id=? AND ((${options.taskId ? 'task_id=?' : '1'}) OR snapshot_id IN (SELECT value FROM json_each(?))) ${options.source ? 'AND source=?' : ''}`,
      ).all(
        runId,
        ...(options.taskId ? [options.taskId] : []),
        JSON.stringify(options.extraIds ?? []),
        ...(options.source ? [options.source] : []),
      ) as any[]
    ).map((row) => row.snapshot_id as string);
  }
  artifactCount(taskId: string, name: string) {
    return Number(
      (
        this.prepare('SELECT COUNT(*) n FROM async_artifacts_v1 WHERE task_id=? AND name=?').get(
          taskId,
          name,
        ) as any
      ).n,
    );
  }
  artifactPage(runId: string, taskId: string, extraIds: string[], after?: string, limit = 32) {
    const scope = 'run_id=? AND (verified=1 OR task_id=? OR artifact_id IN (SELECT value FROM json_each(?)))';
    const args = [runId, taskId, JSON.stringify(extraIds)];
    const total = Number(
      (this.prepare(`SELECT COUNT(*) n FROM async_artifacts_v1 WHERE ${scope}`).get(...args) as any).n,
    );
    const rows = this.prepare(
      `SELECT artifact_id id,name,hash,task_id taskId FROM async_artifacts_v1 WHERE ${scope} ${after ? 'AND artifact_id>?' : ''} ORDER BY artifact_id LIMIT ?`,
    ).all(...args, ...(after ? [after] : []), limit + 1) as {
      id: string;
      name: string;
      hash: string;
      taskId: string;
    }[];
    return {
      items: rows.slice(0, limit),
      total,
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  questionCount(runId: string) {
    return Number(
      (
        this.prepare(
          "SELECT COUNT(*) n FROM async_work_v1 WHERE run_id=? AND status='WAITING' AND wait_reason='user'",
        ).get(runId) as any
      ).n,
    );
  }
  questionTaskIds(runId: string, limit = Number.MAX_SAFE_INTEGER) {
    return (
      this.prepare(
        "SELECT task_id FROM async_work_v1 WHERE run_id=? AND status='WAITING' AND wait_reason='user' ORDER BY task_id LIMIT ?",
      ).all(runId, limit) as any[]
    ).map((row) => row.task_id as string);
  }
  private sequence() {
    return Number(
      (this.prepare('UPDATE async_clock_v1 SET seq=seq+1 WHERE id=1 RETURNING seq').get() as any).seq,
    );
  }
  writeRun(run: Run) {
    if (!run.limits) this.unreadable('runs', run.id, run.id);
    this.prepare(
      'INSERT INTO async_runs_v1(run_id,mode) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET mode=excluded.mode',
    ).run(
      run.id,
      run.limits?.scheduling === 'async' && run.execution?.kind !== 'docker-agent' ? 'async' : 'legacy',
    );
  }
  writeTask(task: Task, previous?: Task) {
    const valid =
      typeof task.agentId === 'string' &&
      typeof task.spec?.key === 'string' &&
      typeof task.spec?.role === 'string';
    if (!valid) this.unreadable('tasks', task.id, task.runId);
    const prior = this.prepare('SELECT status,queue_seq FROM async_work_v1 WHERE task_id=?').get(
      task.id,
    ) as any;
    const order =
      !prior || (prior.status !== 'READY' && task.status === 'READY') ? this.sequence() : prior.queue_seq;
    this.prepare(
      `INSERT INTO async_work_v1(task_id,run_id,parent_id,agent_id,task_key,role,model,status,wait_reason,ready_at,queue_seq,required,needs_decision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      parent_id=excluded.parent_id,agent_id=excluded.agent_id,task_key=excluded.task_key,role=excluded.role,model=excluded.model,
      status=excluded.status,wait_reason=excluded.wait_reason,ready_at=excluded.ready_at,queue_seq=excluded.queue_seq,required=excluded.required,needs_decision=excluded.needs_decision`,
    ).run(
      task.id,
      task.runId,
      task.parentTaskId ?? null,
      task.agentId ?? '',
      task.spec?.key ?? task.id,
      task.spec?.role ?? '',
      task.spec?.model ?? '',
      valid ? task.status : 'WAITING',
      task.waitReason ?? null,
      task.rateLimit?.resumeAt ?? 0,
      order,
      task.spec?.required ? 1 : 0,
      ['FAILED', 'CANCELLED'].includes(task.status) ||
        (task.status === 'WAITING' &&
          (task.waitReason === 'no_progress' ||
            (task.waitReason === 'dependency_failed' && task.dependencyBlock?.causes.length !== 0)))
        ? 1
        : 0,
    );
    if (task.parentTaskId && (!previous || previous.spec?.required !== task.spec?.required)) {
      this.prepare("DELETE FROM async_edges_v1 WHERE source=? AND target=? AND kind='required'").run(
        task.parentTaskId,
        task.id,
      );
      if (task.spec?.required)
        this.prepare("INSERT OR IGNORE INTO async_edges_v1 VALUES(?,?,'required')").run(
          task.parentTaskId,
          task.id,
        );
    }
    if (
      !previous ||
      JSON.stringify(previous.waitingFor) !== JSON.stringify(task.waitingFor) ||
      previous.waitReason !== task.waitReason ||
      previous.waitAllChildren !== task.waitAllChildren ||
      previous.status !== task.status
    )
      this.writeWaits(task);
    if (
      !previous ||
      previous.status !== task.status ||
      previous.waitReason !== task.waitReason ||
      JSON.stringify(previous.dependencyBlock) !== JSON.stringify(task.dependencyBlock)
    ) {
      this.prepare(
        `INSERT OR IGNORE INTO async_dirty_v1 SELECT source FROM async_edges_v1 WHERE target=? AND kind='dependency'`,
      ).run(task.id);
      this.prepare('INSERT OR IGNORE INTO async_dirty_v1 VALUES(?)').run(task.id);
    }
    if (previous && previous.spec?.model !== task.spec?.model)
      this.prepare(
        "UPDATE async_work_v1 SET stage='model',message_id=NULL,owner=NULL,lease_until=NULL,fence=fence+1 WHERE task_id=?",
      ).run(task.id);
    if (
      task.status === 'CANCELLED' ||
      (task.status === 'WAITING' && ['paused', 'interrupted', 'verification'].includes(task.waitReason ?? ''))
    )
      this.invalidate(task.id);
  }
  writeAgent(agent: Agent, previous?: Agent) {
    if (!agent.providerBinding || !agent.taskId) {
      this.unreadable('agents', agent.id, agent.runId);
      return;
    }
    this.prepare('UPDATE async_work_v1 SET model=? WHERE task_id=?').run(
      agent.providerBinding.model,
      agent.taskId,
    );
    if (previous && previous.sessionId !== agent.sessionId)
      this.prepare(
        "UPDATE async_work_v1 SET stage='model',message_id=NULL,owner=NULL,lease_until=NULL,fence=fence+1 WHERE task_id=?",
      ).run(agent.taskId);
  }
  writeOperation(operation: Operation) {
    this.prepare(
      `INSERT INTO async_operations_v1 VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET task_id=excluded.task_id,attempt_id=excluded.attempt_id,name=excluded.name,status=excluded.status`,
    ).run(
      operation.id,
      operation.taskId ?? '',
      operation.attemptId ?? '',
      operation.name ?? '',
      operation.status,
    );
  }
  operationIds(taskId: string, options: { name?: string; attemptId?: string; pending?: boolean } = {}) {
    return (
      this.prepare(
        `SELECT operation_id FROM async_operations_v1 WHERE task_id=? ${options.name ? 'AND name=?' : ''} ${options.attemptId ? 'AND attempt_id=?' : ''} ${options.pending ? "AND status NOT IN ('DONE','FAILED')" : ''}`,
      ).all(
        taskId,
        ...(options.name ? [options.name] : []),
        ...(options.attemptId ? [options.attemptId] : []),
      ) as any[]
    ).map((r) => r.operation_id as string);
  }
  hasReviewers(runId: string) {
    return !!this.prepare("SELECT 1 FROM async_work_v1 WHERE run_id=? AND role='reviewer' LIMIT 1").get(
      runId,
    );
  }
  private writeWaits(task: Task) {
    this.prepare("DELETE FROM async_edges_v1 WHERE source=? AND kind='wait'").run(task.id);
    this.prepare('DELETE FROM async_wait_groups_v1 WHERE parent_id=?').run(task.id);
    if (task.status === 'WAITING' && task.waitReason === 'children')
      this.prepare('INSERT INTO async_wait_groups_v1(parent_id) VALUES(?)').run(task.id);
    if (task.status === 'WAITING' && task.waitReason === 'children' && task.waitAllChildren)
      this.prepare(
        "INSERT OR IGNORE INTO async_edges_v1 SELECT ?,task_id,'wait' FROM async_work_v1 WHERE parent_id=? AND run_id=?",
      ).run(task.id, task.id, task.runId);
    else if (task.status === 'WAITING' && task.waitReason === 'children')
      for (const child of task.waitingFor ?? [])
        this.prepare("INSERT OR IGNORE INTO async_edges_v1 VALUES(?,?,'wait')").run(task.id, child);
  }
  addDependency(taskId: string, target: string) {
    this.prepare("INSERT OR IGNORE INTO async_edges_v1 VALUES(?,?,'dependency')").run(taskId, target);
    this.prepare('INSERT OR IGNORE INTO async_dirty_v1 VALUES(?)').run(taskId);
  }
  countChildren(taskId: string) {
    return Number(
      (this.prepare('SELECT COUNT(*) n FROM async_work_v1 WHERE parent_id=?').get(taskId) as any).n,
    );
  }
  waitSummary(taskId: string) {
    const stats = (this.prepare(
      'SELECT total,pending,decisions decision FROM async_wait_groups_v1 WHERE parent_id=?',
    ).get(taskId) as any) ?? { total: 0, pending: 0, decision: 0 };
    const ids = (
      this.prepare(
        `SELECT c.task_id FROM async_edges_v1 e JOIN async_work_v1 c ON c.task_id=e.target WHERE e.source=? AND e.kind='wait' ORDER BY c.needs_decision DESC,c.task_id LIMIT 32`,
      ).all(taskId) as any[]
    ).map((r) => r.task_id as string);
    return { total: stats.total, complete: stats.pending === 0, needsDecision: stats.decision > 0, ids };
  }
  countAgents(runId: string) {
    return Number((this.prepare('SELECT COUNT(*) n FROM agents WHERE run_id=?').get(runId) as any).n);
  }
  findTask(runId: string, key: string) {
    return (
      (this.prepare('SELECT task_id FROM async_work_v1 WHERE task_id=? AND run_id=?').get(
        key,
        runId,
      ) as any) ??
      (this.prepare('SELECT task_id FROM async_work_v1 WHERE run_id=? AND task_key=? LIMIT 1').get(
        runId,
        key,
      ) as any)
    )?.task_id as string | undefined;
  }
  taskIds(runId: string, options: { parentId?: string; after?: string; limit?: number } = {}) {
    const { parentId, after, limit = 64 } = options;
    return (
      this.prepare(
        `SELECT task_id FROM async_work_v1 WHERE run_id=? ${parentId === undefined ? '' : 'AND parent_id=?'} ${after ? 'AND task_id>?' : ''} ORDER BY task_id LIMIT ?`,
      ).all(runId, ...(parentId === undefined ? [] : [parentId]), ...(after ? [after] : []), limit) as any[]
    ).map((r) => r.task_id as string);
  }
  attemptIds(taskId: string, statuses?: string[]) {
    const task = this.store.require<Task>('tasks', taskId);
    return (
      this.prepare(
        `SELECT id FROM attempts WHERE run_id=? AND json_extract(data,'$.taskId')=? ${statuses?.length ? `AND json_extract(data,'$.status') IN (${statuses.map(() => '?').join(',')})` : ''} ORDER BY rowid`,
      ).all(task.runId, taskId, ...(statuses ?? [])) as any[]
    ).map((r) => r.id as string);
  }
  descendantIds(taskId: string) {
    return (
      this.prepare(
        `WITH RECURSIVE tree(id) AS (VALUES(?) UNION SELECT w.task_id FROM async_work_v1 w JOIN tree t ON w.parent_id=t.id)
      SELECT id FROM tree`,
      ).all(taskId) as any[]
    ).map((r) => r.id as string);
  }
  wouldCycle(taskId: string, dependencies: string[]) {
    return !!this.prepare(
      `WITH RECURSIVE reachable(id) AS (SELECT value FROM json_each(?) UNION SELECT target FROM async_edges_v1 WHERE source=? AND kind='wait' UNION SELECT e.target FROM async_edges_v1 e JOIN reachable r ON e.source=r.id)
      SELECT 1 FROM reachable WHERE id=? LIMIT 1`,
    ).get(JSON.stringify(dependencies), taskId, taskId);
  }
  waitingParents(runId: string, limit = 64) {
    return (
      this.prepare(
        `SELECT w.task_id FROM async_wait_groups_v1 g JOIN async_work_v1 w ON w.task_id=g.parent_id
      WHERE w.run_id=? AND w.status='WAITING' AND w.wait_reason='children' AND (g.pending=0 OR g.decisions>0)
      ORDER BY w.queue_seq LIMIT ?`,
      ).all(runId, limit) as any[]
    ).map((r) => r.task_id as string);
  }
  dirtyDependencies(runId: string, limit = 64) {
    return (
      this.prepare(
        `SELECT d.task_id FROM async_dirty_v1 d JOIN async_work_v1 w ON w.task_id=d.task_id WHERE w.run_id=? ORDER BY w.queue_seq LIMIT ?`,
      ).all(runId, limit) as any[]
    ).map((r) => r.task_id as string);
  }
  acknowledgeDependency(taskId: string) {
    this.prepare('DELETE FROM async_dirty_v1 WHERE task_id=?').run(taskId);
  }
  /** 只加载有限候选；持久轮转也移动受限候选，避免队首被一个账号永久占据。 */
  candidates(limit = 64, runId?: string, rotate = false) {
    const runs = this.prepare(
      `SELECT r.run_id FROM async_runs_v1 r WHERE ${runId ? 'r.run_id=? AND ' : ''}
      EXISTS(SELECT 1 FROM async_work_v1 w WHERE w.run_id=r.run_id AND w.status='READY' AND w.ready_at<=?)
      AND NOT EXISTS(SELECT 1 FROM execution_holds_v1 h WHERE h.run_id=r.run_id) ORDER BY r.scan_seq,r.run_id LIMIT 16`,
    ).all(...(runId ? [runId] : []), Date.now()) as any[];
    const ids: string[] = [];
    for (const run of runs) {
      const rows = this.prepare(
        "SELECT task_id FROM async_work_v1 WHERE run_id=? AND status='READY' AND ready_at<=? ORDER BY queue_seq LIMIT ?",
      ).all(run.run_id, Date.now(), Math.max(1, Math.floor(limit / Math.max(1, runs.length)))) as any[];
      ids.push(...rows.map((r) => r.task_id));
      if (rotate) {
        this.prepare('UPDATE async_runs_v1 SET scan_seq=? WHERE run_id=?').run(this.sequence(), run.run_id);
        for (const row of rows)
          this.prepare('UPDATE async_work_v1 SET queue_seq=? WHERE task_id=?').run(
            this.sequence(),
            row.task_id,
          );
      }
    }
    return ids;
  }
  countReady(runId?: string) {
    return Number(
      (
        this.prepare(
          `SELECT COUNT(*) n FROM async_work_v1 WHERE status='READY' ${runId ? 'AND run_id=?' : ''}`,
        ).get(...(runId ? [runId] : [])) as any
      ).n,
    );
  }
  claim(taskId: string): WorkLease {
    const owner = randomUUID();
    const row = this.prepare(
      `UPDATE async_work_v1 SET owner=?,fence=fence+1,lease_until=? WHERE task_id=? AND owner IS NULL AND status='RUNNING'
      RETURNING task_id taskId,owner,fence,stage,message_id messageId`,
    ).get(owner, Date.now() + 120000, taskId) as unknown as WorkLease | undefined;
    if (!row) throw new AppError('EXECUTION_OWNED', '任务已有执行者，需确认其停止后再恢复');
    return row;
  }
  owns(lease: WorkLease) {
    return !!this.prepare('SELECT 1 FROM async_work_v1 WHERE task_id=? AND owner=? AND fence=?').get(
      lease.taskId,
      lease.owner,
      lease.fence,
    );
  }
  advance(lease: WorkLease, stage: NativeStage, messageId: string | null = lease.messageId) {
    const changed = this.prepare(
      'UPDATE async_work_v1 SET stage=?,message_id=?,lease_until=? WHERE task_id=? AND owner=? AND fence=?',
    ).run(stage, messageId, Date.now() + 120000, lease.taskId, lease.owner, lease.fence);
    if (!changed.changes) throw new AppError('STALE_EXECUTION', '执行阶段已失效');
    lease.stage = stage;
    lease.messageId = messageId;
  }
  release(lease: WorkLease) {
    this.prepare(
      'UPDATE async_work_v1 SET owner=NULL,lease_until=NULL WHERE task_id=? AND owner=? AND fence=?',
    ).run(lease.taskId, lease.owner, lease.fence);
  }
  invalidate(taskId: string) {
    this.prepare('UPDATE async_work_v1 SET owner=NULL,lease_until=NULL,fence=fence+1 WHERE task_id=?').run(
      taskId,
    );
  }
  stage(taskId: string): NativeStage {
    return (
      (this.prepare('SELECT stage FROM async_work_v1 WHERE task_id=?').get(taskId) as any)?.stage ?? 'model'
    );
  }
  /** 租约超时不自动重领；恢复由现有请求/工具核验完成后显式解除。 */
  recover(runId?: string) {
    this.prepare(
      `UPDATE async_work_v1 SET owner=NULL,lease_until=NULL,fence=fence+1 ${runId ? 'WHERE run_id=?' : ''}`,
    ).run(...(runId ? [runId] : []));
  }
  writeRequest(request: RequestRecord) {
    if (!request.taskId || !Number.isFinite(request.reservedTokens)) {
      this.unreadable('requests', request.id, request.runId);
      return;
    }
    const currency = request.providerBinding?.prices?.currency ?? '';
    const tokens =
      request.status === 'RELEASED'
        ? 0
        : request.status === 'SETTLED'
          ? (request.usage?.inputTotal ?? request.reservedTokens) + (request.usage?.outputTotal ?? 0)
          : request.reservedTokens;
    const cost = request.status === 'RELEASED' ? 0 : (request.usage?.cost ?? request.reservedCost ?? 0);
    const old = this.prepare('SELECT * FROM async_request_budget_v1 WHERE request_id=?').get(
      request.id,
    ) as any;
    if (
      old &&
      old.currency === currency &&
      old.tokens === tokens &&
      old.cost === cost &&
      old.task_id === request.taskId
    )
      return;
    const ancestors = (id: string) =>
      (
        this.prepare(
          `WITH RECURSIVE chain(id,parent) AS (SELECT task_id,parent_id FROM async_work_v1 WHERE task_id=? UNION SELECT w.task_id,w.parent_id FROM async_work_v1 w JOIN chain c ON w.task_id=c.parent) SELECT id FROM chain`,
        ).all(id) as any[]
      ).map((r) => r.id as string);
    const add = (taskId: string, c: string, n: number, t: number, m: number) =>
      this.prepare(
        `INSERT INTO async_budget_v1 VALUES(?,?,?,?,?) ON CONFLICT(task_id,currency) DO UPDATE SET requests=requests+excluded.requests,tokens=tokens+excluded.tokens,cost=cost+excluded.cost`,
      ).run(taskId, c, n, t, m);
    if (old)
      for (const ancestor of ancestors(old.task_id)) add(ancestor, old.currency, -1, -old.tokens, -old.cost);
    for (const ancestor of ancestors(request.taskId)) add(ancestor, currency, 1, tokens, cost);
    this.prepare(
      `INSERT INTO async_request_budget_v1 VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET task_id=excluded.task_id,currency=excluded.currency,tokens=excluded.tokens,cost=excluded.cost`,
    ).run(request.id, request.taskId, currency, tokens, cost);
  }
  budget(taskId: string): BudgetTotal {
    const rows = this.prepare('SELECT * FROM async_budget_v1 WHERE task_id=? AND requests>0').all(
      taskId,
    ) as any[];
    return {
      requests: rows.reduce((s, r) => s + r.requests, 0),
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      cost: rows.reduce((s, r) => s + r.cost, 0),
      currencies: rows.map((r) => r.currency),
    };
  }
  reviewModels(runId: string, replacing: string[]) {
    const current = this.prepare(
      `SELECT DISTINCT role,model FROM async_work_v1 WHERE run_id=? AND status!='CANCELLED' AND task_id NOT IN (SELECT value FROM json_each(?))`,
    ).all(runId, JSON.stringify(replacing)) as any[];
    const historical = this.prepare(
      `SELECT DISTINCT w.role,json_extract(r.data,'$.requestLedger.model') model FROM requests r LEFT JOIN async_work_v1 w ON w.task_id=json_extract(r.data,'$.requestLedger.taskId')
      WHERE r.run_id=? AND COALESCE(json_extract(r.data,'$.requestLedger.status'),'UNKNOWN')!='RELEASED' AND COALESCE(json_extract(r.data,'$.requestLedger.purpose'),'assistant')!='tool-review'`,
    ).all(runId) as any[];
    return [...current, ...historical].map((r) => ({
      key: r.role + ':' + r.model,
      title: r.role ?? '',
      role: r.role ?? '',
      model: r.model ?? '',
    }));
  }
}
