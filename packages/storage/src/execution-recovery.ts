/**
 * 持久保存执行暂停及恢复问题，避免损坏记录导致任务继续运行。
 * EN: Persist execution holds and recovery issues so unreadable records do not silently resume
 * execution.
 *
 * 将暂停原因和待核验问题作为持久状态管理，恢复流程先读取问题再决定是否继续，避免将解析失败当成无问题。
 * EN: Persist holds and verification issues so recovery checks them before continuing, rather than interpreting parsing failure as the absence of an issue.
 */
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
/**
 * 只接受非空非数组对象，作为恢复必需字段的结构检查。
 * EN: Accept only non-null, non-array objects when validating recovery-required fields.
 */
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 创建持久暂停和不可读记录表；原记录修改或删除时清除对应问题标记。
 * EN: Create durable hold and unreadable-record tables. Changes or deletion of the source record
 * clear the associated issue marker.
 */
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
    // 修复清除问题标记，但不能解除用户设置的持久执行暂停。
    // EN: Repair clears the issue marker, never the user durable execution hold.
    db.exec(`CREATE TRIGGER IF NOT EXISTS recovery_issue_${table}_changed
      AFTER UPDATE ON ${table} WHEN NEW.content IS NOT OLD.content OR NEW.run_id IS NOT OLD.run_id
        OR NEW.revision IS NOT OLD.revision OR NEW.data IS NOT OLD.data
      BEGIN DELETE FROM execution_recovery_issues_v1 WHERE table_name='${table}' AND record_id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS recovery_issue_${table}_deleted AFTER DELETE ON ${table}
      BEGIN DELETE FROM execution_recovery_issues_v1 WHERE table_name='${table}' AND record_id=OLD.id; END;`);
  }
}

class RecoveryReadError extends Error {
  /**
   * 保存不可读记录的表名和ID，让恢复失败可登记到真实问题来源。
   * EN: Retain the unreadable record table and ID so recovery can register the actual failing source.
   */
  constructor(
    readonly table: RecoveryTable,
    readonly id: string,
  ) {
    super('Execution record unreadable');
  }
}

/**
 * 管理跨进程重启保留的执行暂停及恢复问题，不改写不可读的业务正文。
 * EN: Manage execution holds and recovery issues across process restarts without rewriting
 * unreadable business bodies.
 */
export class ExecutionRecovery {
  /**
   * 保存Store引用，恢复状态通过其数据库和事务接口读写。
   * EN: Retain the Store used to read and write recovery state through its database and transaction interfaces.
   */
  constructor(private store: Store) {}
  /**
   * 读取独立暂停记录并附带当前不可读问题数量；暂停存在与否不取决于业务正文能否解压。
   * EN: Read the independent hold record with its current unreadable-issue count; hold existence does
   * not depend on decompressing the business body.
   */
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
  /**
   * 设置持久暂停；已有不可读原因时保留该原因，直到记录修复并显式恢复。
   * EN: Set a durable hold and preserve an existing unreadable-record reason until records are
   * repaired and execution is explicitly resumed.
   */
  hold(runId: string, reason: ExecutionHold['reason']) {
    this.store.db
      .prepare(
        `INSERT INTO execution_holds_v1(run_id,reason,since) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET reason=CASE WHEN reason='recovery_unreadable' THEN reason ELSE excluded.reason END`,
      )
      .run(runId, reason, new Date().toISOString());
    return this.get(runId)!;
  }
  /**
   * 先重新核验未完成执行记录，再解除暂停。
   * EN: Recheck unresolved execution records before releasing the durable hold.
   */
  release(runId: string) {
    this.assertReadable(runId);
    this.store.db.prepare('DELETE FROM execution_holds_v1 WHERE run_id=?').run(runId);
  }
  /**
   * 按 SQL 归属定位运行，在同事务登记问题与持久暂停；孤立或缺失行返回 false。
   * EN: Locate ownership through SQL metadata and record the issue and durable hold in one
   * transaction. Return false for missing or ownerless rows.
   */
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
  /**
   * 读取记录并核验身份、版本、状态和所属关系；retry 允许重新检查已记录的问题。
   * EN: Read a record and validate identity, revision, status, and ownership. retry permits rechecking
   * an already reported issue.
   */
  read<T extends Entity>(table: RecoveryTable, id: string, retry = false): T {
    return this.readRecord<T>(table, id, retry, true);
  }
  /**
   * 检查正文与 SQL 的 ID、revision、run_id 以及各表执行必需字段。
   * checkScope=false 只用于关系核验的第二层读取，避免 task/agent 双向关系造成无限递归。
   * 已知问题默认短路失败；SQLite 本身的错误不会包装成业务数据损坏。
   * EN: Compare body and SQL ID, revision, run_id, and table-specific execution fields. Use
   * checkScope=false only for second-level relationship reads to avoid infinite task/agent recursion.
   * Known issues fail early by default; database errors are not reclassified as corrupt business data.
   */
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
  /**
   * 交叉验证根任务、代理、执行尝试与运行的所属关系；仅字段形状正确不足以恢复执行。
   * 关联行以不再递归展开关系的方式读取，当前实体负责核对本层必需的双向标识。
   * EN: Cross-check ownership of the root task, agent, attempt, and run; valid field shapes alone are
   * insufficient for recovery. Read related records without recursively traversing ownership again,
   * and verify the required relationships at the current level.
   */
  private assertScope(table: RecoveryTable, value: any, retry: boolean) {
    /**
     * 读取关联实体但不递归再验证关系，防止双向task/agent关系形成循环。
     * EN: Read a related entity without recursively checking ownership again, avoiding task/agent cycles.
     */
    const related = (ownerTable: RecoveryTable, key: string) =>
      this.readRecord<any>(ownerTable, key, retry, false);
    /**
     * 要求关联实体和当前记录属于同一运行，失败立即停止恢复核验。
     * EN: Require related and current records to belong to the same run, failing ownership verification otherwise.
     */
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
  /**
   * 每条恢复操作独立回滚；失败后登记不可读问题并持久暂停所属运行。
   * EN: Roll back each recovery action independently, then record the unreadable issue and durably
   * hold its run on failure.
   */
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
  /**
   * 查找指定状态的恢复候选；状态缺失也纳入核验，已登记问题暂不重复处理。
   * EN: Select recovery candidates in the requested states, including missing-state rows for
   * verification. Skip already reported issues until they are explicitly retried.
   */
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
  /**
   * 核验运行、已登记的问题和尚未结束的执行记录，不全面扫描历史记录。
   * EN: Recheck the run, reported issues, and unresolved execution records without scanning all
   * terminal history.
   */
  assertReadable(runId: string) {
    const issues = this.store.db
      .prepare('SELECT table_name,record_id FROM execution_recovery_issues_v1 WHERE run_id=?')
      .all(runId) as { table_name: RecoveryTable; record_id: string }[];
    // 正文修改会清除旧诊断，但仍需核对所属关系。仅复核运行与未完成执行记录，不全面扫描已结束历史。
    // EN: Editing a body clears its old diagnostic but still requires an ownership check. Recheck the
    // run and unresolved execution records, not all terminal history.
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
