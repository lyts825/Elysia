/**
 * 按连接复用高频参数化 SQL 的预编译语句，不缓存查询结果或业务数据。
 * EN: Reuse prepared statements for frequent parameterized SQL within one connection, without
 * caching query results or business data.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const MAX_STATEMENTS = 64;

export class StatementCache {
  private statements = new Map<string, StatementSync>();

  constructor(private db: DatabaseSync) {}

  /**
   * 最多保留 64 条最近使用的语句；调用方须同步执行完毕，活动迭代器结束前不得重入同一语句。
   * EN: Retain at most 64 recently used statements. Callers must finish execution synchronously and
   * must not reenter the same statement while its iterator is active.
   */
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement) this.statements.delete(sql);
    else {
      statement = this.db.prepare(sql);
      if (this.statements.size >= MAX_STATEMENTS)
        this.statements.delete(this.statements.keys().next().value!);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  /**
   * 关闭连接时释放缓存引用；SQLite 语句的最终释放由数据库连接负责。
   * EN: Release cached references when closing; the database connection owns statement finalization.
   */
  clear() {
    this.statements.clear();
  }
}
