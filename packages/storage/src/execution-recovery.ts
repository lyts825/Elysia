import type { DatabaseSync } from 'node:sqlite';
import { AppError, Status, type Entity } from '../../contracts/src/index.js';
import type { ExecutionHold } from '../../contracts/src/run-reads.js';
import type { Store } from './index.js';

export type RecoveryTable = 'runs' | 'tasks' | 'agents' | 'attempts' | 'requests' | 'tool_operations';
const states: Record<RecoveryTable, readonly string[]> = {
  runs: Status.options,
  tasks: Status.options,
  agents: Status.options,
  attempts: ['ACTIVE', 'WAITING', 'DONE', 'FAILED', 'CANCELLED'],
  requests: ['RESERVED', 'SETTLED', 'UNKNOWN', 'RELEASED'],
  tool_operations: ['INTENT', 'DONE', 'FAILED', 'UNCERTAIN'],
};
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function initializeExecutionRecovery(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS execution_holds_v1(
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK(reason IN ('user_stop','recovery_unreadable')),since TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_recovery_issues_v1(
      table_name TEXT NOT NULL,record_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      PRIMARY KEY(table_name,record_id));
    CREATE INDEX IF NOT EXISTS execution_recovery_issue_run ON execution_recovery_issues_v1(run_id);`);
  for (const table of Object.keys(states)) {
    // Repair clears the issue, never the user's durable execution hold.
    db.exec(`CREATE TRIGGER IF NOT EXISTS recovery_issue_${table}_changed
      AFTER UPDATE ON ${table} WHEN NEW.content IS NOT OLD.content OR NEW.run_id IS NOT OLD.run_id
        OR NEW.revision IS NOT OLD.revision OR NEW.data IS NOT OLD.data
      BEGIN DELETE FROM execution_recovery_issues_v1 WHERE table_name='${table}' AND record_id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS recovery_issue_${table}_deleted AFTER DELETE ON ${table}
      BEGIN DELETE FROM execution_recovery_issues_v1 WHERE table_name='${table}' AND record_id=OLD.id; END;`);
  }
}

class RecoveryReadError extends Error {
  constructor(
    readonly table: RecoveryTable,
    readonly id: string,
  ) {
    super('Execution record unreadable');
  }
}

/** Small authoritative holds survive process exit without rewriting unreadable business bodies. */
export class ExecutionRecovery {
  constructor(private store: Store) {}
  get(runId: string): ExecutionHold | undefined {
    const row = this.store.db
      .prepare(
        `SELECT reason,since,
      (SELECT COUNT(*) FROM execution_recovery_issues_v1 WHERE run_id=?) issueCount
      FROM execution_holds_v1 WHERE run_id=?`,
      )
      .get(runId, runId) as Omit<ExecutionHold, 'message'> | undefined;
    return (
      row && {
        ...row,
        message:
          row.reason === 'recovery_unreadable'
            ? '恢复时发现无法核验的执行记录，已持久停止此任务调度。原文保留；修复记录后需显式恢复。'
            : '此任务已持久停止调度，重启后仍保持停止；检查执行结果后可显式恢复。',
      }
    );
  }
  hold(runId: string, reason: ExecutionHold['reason']) {
    this.store.db
      .prepare(
        `INSERT INTO execution_holds_v1(run_id,reason,since) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET reason=CASE WHEN reason='recovery_unreadable' THEN reason ELSE excluded.reason END`,
      )
      .run(runId, reason, new Date().toISOString());
    return this.get(runId)!;
  }
  release(runId: string) {
    this.assertReadable(runId);
    this.store.db.prepare('DELETE FROM execution_holds_v1 WHERE run_id=?').run(runId);
  }
  private issue(table: RecoveryTable, id: string) {
    const row = this.store.db
      .prepare(`SELECT ${table === 'runs' ? 'id' : 'run_id'} runId FROM ${table} WHERE id=?`)
      .get(id) as { runId: string } | undefined;
    if (!row?.runId) return false;
    this.store.tx(() => {
      this.hold(row.runId, 'recovery_unreadable');
      this.store.db
        .prepare('INSERT OR REPLACE INTO execution_recovery_issues_v1 VALUES(?,?,?)')
        .run(table, id, row.runId);
    });
    return true;
  }
  read<T extends Entity>(table: RecoveryTable, id: string, retry = false): T {
    return this.readRecord<T>(table, id, retry, true);
  }
  private readRecord<T extends Entity>(
    table: RecoveryTable,
    id: string,
    retry: boolean,
    checkScope: boolean,
  ): T {
    try {
      if (
        !retry &&
        this.store.db
          .prepare('SELECT 1 FROM execution_recovery_issues_v1 WHERE table_name=? AND record_id=?')
          .get(table, id)
      )
        throw new RecoveryReadError(table, id);
      const metadata = this.store.db.prepare(`SELECT revision,run_id FROM ${table} WHERE id=?`).get(id) as
        | { revision: number; run_id: string | null }
        | undefined;
      const value = this.store.get<any>(table, id);
      if (
        !value ||
        !metadata ||
        value.id !== id ||
        value.revision !== metadata.revision ||
        (value.runId ?? null) !== metadata.run_id ||
        !states[table].includes(value.status) ||
        (table === 'runs' &&
          (!object(value.limits) ||
            typeof value.rootTaskId !== 'string' ||
            typeof value.objective !== 'string')) ||
        (table === 'tasks' &&
          (!object(value.spec) || typeof value.agentId !== 'string' || !Array.isArray(value.waitingFor))) ||
        (table === 'agents' &&
          (!object(value.providerBinding) ||
            typeof value.sessionId !== 'string' ||
            typeof value.taskId !== 'string')) ||
        (table === 'attempts' && (typeof value.taskId !== 'string' || typeof value.agentId !== 'string')) ||
        (table === 'requests' &&
          (!object(value.manifest) ||
            typeof value.taskId !== 'string' ||
            !Number.isFinite(value.reservedTokens))) ||
        (table === 'tool_operations' &&
          (typeof value.taskId !== 'string' || typeof value.name !== 'string' || !object(value.args)))
      )
        throw new Error('Invalid execution fields');
      if (checkScope) this.assertScope(table, value, retry);
      return value;
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_SQLITE_ERROR') throw error;
      throw new RecoveryReadError(table, id);
    }
  }
  private assertScope(table: RecoveryTable, value: any, retry: boolean) {
    const related = (ownerTable: RecoveryTable, key: string) =>
      this.readRecord<any>(ownerTable, key, retry, false);
    const sameRun = (record: any) => {
      if (record.runId !== value.runId) throw new Error('Execution record owner mismatch');
      return record;
    };
    if (table === 'runs') {
      const root = related('tasks', value.rootTaskId);
      if (root.runId !== value.id) throw new Error('Execution root owner mismatch');
      const agent = related('agents', root.agentId);
      if (agent.runId !== value.id || agent.taskId !== root.id)
        throw new Error('Execution root agent mismatch');
      return;
    }
    related('runs', value.runId);
    if (table === 'tasks') {
      const agent = sameRun(related('agents', value.agentId));
      if (agent.taskId !== value.id) throw new Error('Execution agent owner mismatch');
    } else if (table === 'agents') {
      const task = sameRun(related('tasks', value.taskId));
      if (task.agentId !== value.id) throw new Error('Execution task owner mismatch');
    } else {
      sameRun(related('tasks', value.taskId));
      if (table === 'attempts') {
        const agent = sameRun(related('agents', value.agentId));
        if (agent.taskId !== value.taskId) throw new Error('Execution attempt owner mismatch');
      }
    }
  }
  /** Each recovery action rolls back independently; the issue and hold are recorded afterwards. */
  apply<T extends Entity>(table: RecoveryTable, id: string, work: (entity: T) => void, retry = false) {
    return this.store.tx(() => {
      this.store.db.exec('SAVEPOINT execution_recovery_item');
      try {
        work(this.read<T>(table, id, retry));
        this.store.db.exec('RELEASE execution_recovery_item');
        return true;
      } catch (error) {
        this.store.db.exec('ROLLBACK TO execution_recovery_item; RELEASE execution_recovery_item');
        if ((error as { code?: string }).code === 'ERR_SQLITE_ERROR') throw error;
        if (
          !this.issue(
            error instanceof RecoveryReadError ? error.table : table,
            error instanceof RecoveryReadError ? error.id : id,
          )
        )
          this.issue(table, id);
        return false;
      }
    });
  }
  candidates(table: RecoveryTable, statuses: readonly string[], runId?: string): string[] {
    if (!statuses.length) return [];
    const state = "COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status'))";
    return (
      this.store.db
        .prepare(
          `SELECT id FROM ${table} WHERE (${state} IS NULL OR ${state} IN (SELECT value FROM json_each(?)))
      ${runId ? `AND ${table === 'runs' ? 'id' : 'run_id'}=?` : ''}
      AND NOT EXISTS(SELECT 1 FROM execution_recovery_issues_v1 i WHERE i.table_name=? AND i.record_id=${table}.id)
      ORDER BY rowid`,
        )
        .all(JSON.stringify(statuses), ...(runId ? [runId] : []), table) as { id: string }[]
    ).map((row) => row.id);
  }
  assertReadable(runId: string) {
    const issues = this.store.db
      .prepare('SELECT table_name,record_id FROM execution_recovery_issues_v1 WHERE run_id=?')
      .all(runId) as { table_name: RecoveryTable; record_id: string }[];
    // An edited body clears its old diagnostic, but still needs an ownership check.
    // Recheck only the run and unresolved execution records, never terminal history.
    const checks = new Map(issues.map((item) => [`${item.table_name}:${item.record_id}`, item]));
    checks.set(`runs:${runId}`, { table_name: 'runs', record_id: runId });
    const pending: Partial<Record<RecoveryTable, readonly string[]>> = {
      tasks: ['READY', 'RUNNING', 'VERIFYING', 'WAITING'],
      attempts: ['ACTIVE', 'WAITING'],
      requests: ['RESERVED'],
      tool_operations: ['INTENT', 'UNCERTAIN'],
    };
    for (const [table, statuses] of Object.entries(pending) as [RecoveryTable, readonly string[]][])
      for (const recordId of this.candidates(table, statuses, runId))
        checks.set(`${table}:${recordId}`, { table_name: table, record_id: recordId });
    for (const item of checks.values()) {
      if (this.apply(item.table_name, item.record_id, () => {}, true))
        this.store.db
          .prepare('DELETE FROM execution_recovery_issues_v1 WHERE table_name=? AND record_id=?')
          .run(item.table_name, item.record_id);
    }
    if (this.get(runId)?.issueCount)
      throw new AppError(
        'RECOVERY_UNREADABLE',
        '恢复记录仍无法核验，持久停止保持。请修复原记录后重试。',
        true,
        null,
        422,
      );
  }
}
