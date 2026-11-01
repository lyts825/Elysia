/**
 * 规划并执行对象存储的完整性检查和清理。
 * 完整扫描保留引用后才计划并核验删除孤立对象；数据库或对象完整性未知即停止，删除不回滚，部分结果和审计供重试核对。
 * EN: Plans and executes object-store integrity inspection and cleanup. Plans/verifies orphan deletion only after complete retained-reference scans; unknown integrity stops work and irreversible deletion preserves partial results/audits for retries.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hash, now, tables, STORAGE_SCHEMA_VERSION } from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import { automationObjectReferences } from '../../../packages/storage/src/automation.js';
import { automationReferenceClosure } from '../../../packages/storage/src/automation-object-references.js';
import {
  assertDirectory,
  assertSurfacePath,
  surfaceDirectory,
  type Selection,
  type Surface,
} from './maintenance-storage.js';

const objectPattern = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema = z
  .object({
    ref: z.string().regex(objectPattern),
    bytes: z.number().int().nonnegative(),
    identity: digest,
  })
  .strict();
export const ObjectCleanupPlan = z
  .object({
    kind: z.literal('elysia-object-cleanup'),
    format: z.literal(1),
    appVersion: z.string(),
    createdAt: z.string().datetime(),
    scope: digest,
    surfaces: z
      .array(
        z
          .object({
            surface: z.enum(['native', 'terminal']),
            database: digest,
            candidates: z.array(candidateSchema).max(1000),
            candidateBytes: z.number().int().nonnegative(),
            truncated: z.boolean(),
            retained: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
type Candidate = z.infer<typeof candidateSchema>;
type Plan = z.infer<typeof ObjectCleanupPlan>;

export type ObjectMaintenancePhase = 'integrity' | 'references' | 'candidates' | 'preflight' | 'delete';
export type ObjectMaintenanceProgress = {
  phase: ObjectMaintenancePhase;
  surface?: Surface;
  table?: string;
  recordsScanned: number;
  filesChecked: number;
  bytesHashed: number;
  deleted: number;
  freedBytes: number;
  alreadyMissing: number;
  totalCandidates: number;
  elapsedMs: number;
};
export type ObjectMaintenanceAudit =
  | { type: 'phase'; phase: ObjectMaintenancePhase; surface?: Surface; table?: string }
  | {
      type: 'delete-started' | 'delete-completed' | 'already-missing';
      surface: Surface;
      ref: string;
      bytes: number;
    };
export type ObjectMaintenanceOptions = {
  cancelled?: () => boolean;
  onProgress?: (progress: ObjectMaintenanceProgress) => void;
  onAudit?: (event: ObjectMaintenanceAudit) => void;
  /**
   * worker在任何清理预检之前原子关闭只读终止门。
   * EN: The worker atomically closes its read-only termination gate before any cleanup preflight.
   */
  beforePreflight?: () => void;
};
export type ObjectMaintenanceResult = ObjectMaintenanceProgress & {
  status: 'completed' | 'cancelled' | 'failed';
  remaining: number;
  surfaces: Surface[];
  errorCode?: 'OBJECT_MAINTENANCE_CANCELLED' | 'OBJECT_MAINTENANCE_FAILED';
  failureReason?:
    | 'plan_invalid'
    | 'reference_changed'
    | 'object_integrity'
    | 'database_changed'
    | 'schema_upgrade_required'
    | 'resource_limit'
    | 'audit_write_failed'
    | 'database_check_failed'
    | 'reference_scan_failed'
    | 'object_scan_failed'
    | 'object_delete_failed';
};
class MaintenanceProblem extends Error {
  /**
   * 保留可公开分类的维护失败原因，供上层统一构造结构化结果。
   * EN: Retains the public maintenance failure category for structured result construction.
   */
  constructor(public reason: ObjectMaintenanceResult['failureReason']) {
    super('对象维护已停止');
  }
}
export class ObjectMaintenanceFailure extends Error {
  /**
   * 将错误说明与已完成部分的维护结果绑定，允许失败后仍报告不可回滚的删除计数。
   * EN: Binds an error message to partial maintenance results, preserving nonrollbackable deletion counts on failure.
   */
  constructor(
    message: string,
    public result: ObjectMaintenanceResult,
  ) {
    super(message);
  }
}
class Scan {
  private started = performance.now();
  private lastProgress = 0;
  readonly state: ObjectMaintenanceProgress = {
    phase: 'integrity',
    recordsScanned: 0,
    filesChecked: 0,
    bytesHashed: 0,
    deleted: 0,
    freedBytes: 0,
    alreadyMissing: 0,
    totalCandidates: 0,
    elapsedMs: 0,
  };
  readonly surfaces = new Set<Surface>();
  /**
   * 保存取消、进度和审计能力；扫描计数从本实例的初始状态开始。
   * EN: Stores cancellation/progress/audit capabilities with counters initialized for this scan instance.
   */
  constructor(private options: ObjectMaintenanceOptions) {}
  /**
   * 切换扫描阶段与入口，登记覆盖入口、持久审计并立即检查取消/推送进度。
   * EN: Changes phase/surface, records coverage and audit, then immediately checks cancellation/emits progress.
   */
  phase(phase: ObjectMaintenancePhase, surface: Surface, table?: string) {
    Object.assign(this.state, { phase, surface, table });
    this.surfaces.add(surface);
    this.audit({ type: 'phase', phase, surface, ...(table ? { table } : {}) });
    this.check(true);
  }
  /**
   * 检查协作取消并以最多约每 250ms 的频率推送计数；强制模式立即推送，取消携带当前部分结果。
   * EN: Checks cooperative cancellation and emits progress roughly every 250ms unless forced; cancellation carries current partial results.
   */
  check(force = false) {
    if (this.options.cancelled?.())
      throw new ObjectMaintenanceFailure(
        '对象维护已取消；已删除对象不会回滚，可使用同一计划重新核验剩余对象。',
        this.result('cancelled'),
      );
    const current = performance.now();
    if (force || current - this.lastProgress >= 250) {
      this.lastProgress = current;
      this.state.elapsedMs = current - this.started;
      this.options.onProgress?.({ ...this.state });
    }
  }
  /**
   * 调用审计持久化能力；任何审计写失败转换为明确维护失败，避免无记录继续删除。
   * EN: Invokes audit persistence and converts recording failures into explicit maintenance failure to prevent unrecorded deletion.
   */
  audit(event: ObjectMaintenanceAudit) {
    try {
      this.options.onAudit?.(event);
    } catch {
      throw new MaintenanceProblem('audit_write_failed');
    }
  }
  /**
   * 克隆当前计数并计算剩余候选及耗时，按状态附错误码；不修改扫描进度。
   * EN: Clones counters with remaining candidates/elapsed time and state-specific error code without mutating scan progress.
   */
  result(status: ObjectMaintenanceResult['status']): ObjectMaintenanceResult {
    return {
      ...this.state,
      elapsedMs: performance.now() - this.started,
      status,
      remaining: Math.max(0, this.state.totalCandidates - this.state.deleted - this.state.alreadyMissing),
      surfaces: [...this.surfaces],
      ...(status === 'completed'
        ? {}
        : {
            errorCode:
              status === 'cancelled'
                ? ('OBJECT_MAINTENANCE_CANCELLED' as const)
                : ('OBJECT_MAINTENANCE_FAILED' as const),
          }),
    };
  }
  /**
   * 根据已知错误、schema 校验及当前阶段选择安全失败分类，并保留部分结果；已有维护失败原样传播。
   * EN: Classifies known errors, schema failures and phase-specific faults while preserving partial results; existing maintenance failures propagate unchanged.
   */
  failed(error: unknown): never {
    if (error instanceof ObjectMaintenanceFailure) throw error;
    const message = error instanceof Error ? error.message : '';
    const reasons: Record<string, NonNullable<ObjectMaintenanceResult['failureReason']>> = {
      维护计划属于另一数据目录: 'plan_invalid',
      维护计划与所选入口不一致: 'plan_invalid',
      维护计划包含重复对象: 'plan_invalid',
      '对象已有引用，请重新预览': 'reference_changed',
      '对象已变化，请重新预览': 'object_integrity',
      '对象在清理期间发生变化，停止处理': 'object_integrity',
      对象内容或身份已变化: 'object_integrity',
      '数据库已被替换，请重新预览': 'database_changed',
      '对象维护要求当前数据格式，请先执行 db:migrate': 'schema_upgrade_required',
    };
    const phaseReason = {
      integrity: 'database_check_failed',
      references: 'reference_scan_failed',
      candidates: 'object_scan_failed',
      preflight: 'object_integrity',
      delete: 'object_delete_failed',
    } as const;
    const failureReason =
      error instanceof MaintenanceProblem
        ? error.reason
        : error instanceof z.ZodError
          ? 'plan_invalid'
          : (error as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE' ||
              message.includes('超过 64 MiB') ||
              message.includes('超过 100 万条')
            ? 'resource_limit'
            : (reasons[message] ?? phaseReason[this.state.phase]);
    throw new ObjectMaintenanceFailure(error instanceof Error ? error.message : '对象维护失败', {
      ...this.result('failed'),
      failureReason,
    });
  }
}
/**
 * 异常巨大或损坏记录须保守失败，不能跳过可能携带引用的值。
 * EN: Fail closed for unusually large/corrupt records; never skip a reference-bearing value.
 */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 1_000_000;
/**
 * 在压缩输入和输出上限内解压记录，前后检查取消；超限不跳过引用而使整个维护失败。
 * EN: Decompresses within compressed/output bounds with cancellation checks; excess fails maintenance rather than skipping possible references.
 */
function decompress(content: Uint8Array, scan: Scan) {
  scan.check();
  if (content.byteLength > MAX_RECORD_BYTES) throw new Error('维护记录超过 64 MiB，已停止且未跳过引用');
  const bytes = gunzipSync(content, { maxOutputLength: MAX_RECORD_BYTES });
  scan.check();
  return bytes;
}

/**
 * 拒绝链接、硬链接和特殊文件并生成身份摘要；数据库身份只绑定设备/inode，普通对象另绑定大小和纳秒修改时间。
 * EN: Rejects links, hard links and special files and hashes identity: device/inode for databases, additionally size/nanosecond mtime for objects.
 */
function identity(file: string, database = false) {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error('对象维护不能处理链接或特殊文件');
  return hash(database ? `${stat.dev}:${stat.ino}` : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`);
}

/**
 * 保留每个像对象引用的字符串，包括保留历史快照， 及压缩文本中的引用，刻意偏向多保留文件。
 * EN: Retain every object-looking string, including objects referenced by retained historical snapshots and compressed text. This deliberately errs on the side of keeping extra files.
 */
function references(value: unknown, retained: Set<string>, scan: Scan) {
  let visited = 0;
  /**
   * 遍历 JSON 自有值收集规范对象引用，周期检查取消并限制引用总数；字符串先按固定长度筛选以免重复扫描大正文。
   * EN: Traverses own JSON values for canonical refs with periodic cancellation/count limits, filtering strings by fixed length to avoid rescanning large bodies.
   */
  const visit = (item: unknown) => {
    if ((visited++ & 255) === 0) scan.check();
    if (typeof item === 'string') {
      /**
       * 规范对象引用长度固定，避免重复扫描大型文本。
       * EN: A normalized object ref always has this exact length; avoid scanning large text twice.
       */
      if (item.length !== 75) return;
      const ref = item.replaceAll('\\', '/');
      if (objectPattern.test(ref)) {
        retained.add(ref);
        if (retained.size > MAX_REFERENCES) throw new Error('维护引用超过 100 万条，已停止且未跳过引用');
      }
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item && typeof item === 'object') {
      /**
       * JSON值只有自有可枚举属性，无需预先分配所有值。
       * EN: JSON values only have own enumerable properties. Do not allocate every value up front.
       */
      for (const key in item) if (Object.hasOwn(item, key)) visit((item as Record<string, unknown>)[key]);
    }
  };
  visit(value);
  scan.check();
}

/**
 * 以只读连接检查当前 schema 与数据库完整性，逐类有界解压所有可能引用对象的保存资料，收集保留集合并核对数据库身份；任何不可读来源使扫描失败，不能猜为无引用。
 * EN: Opens read-only storage, verifies current schema/integrity and boundedly decodes all retained object-reference sources, collecting refs and rechecking database identity. Unreadable sources fail scanning rather than imply no references.
 */
function readReferences(directory: string, scan: Scan, surface: Surface) {
  const filename = path.join(directory, 'state.db');
  const databaseIdentity = identity(filename, true);
  const database = new DatabaseSync(filename, { readOnly: true });
  const retained = new Set<string>();
  try {
    scan.phase('integrity', surface);
    const version = Number((database.prepare('PRAGMA user_version').get() as any).user_version);
    if (version !== STORAGE_SCHEMA_VERSION) throw new Error('对象维护要求当前数据格式，请先执行 db:migrate');
    const check = database.prepare('PRAGMA quick_check').all() as any[];
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('数据库完整性检查失败');
    for (const table of [...tables, 'events', 'commands']) {
      scan.phase('references', surface, table);
      for (const row of database.prepare(`SELECT content FROM ${table}`).iterate() as Iterable<{
        content: Uint8Array;
      }>) {
        scan.check();
        references(JSON.parse(decompress(row.content, scan).toString('utf8')), retained, scan);
        scan.state.recordsScanned++;
      }
    }
    if (
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_review_history_v1'")
        .get()
    ) {
      scan.phase('references', surface, 'delivery_review_history_v1');
      for (const row of database
        .prepare('SELECT review_json,baseline_json FROM delivery_review_history_v1')
        .iterate() as Iterable<{ review_json: string; baseline_json: string | null }>) {
        scan.check();
        for (const value of [row.review_json, row.baseline_json]) {
          if (value === null) continue;
          if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_RECORD_BYTES)
            throw new Error('维护复核历史超过读取上限或格式无效');
          references(JSON.parse(value), retained, scan);
        }
        scan.state.recordsScanned++;
      }
    }
    if (
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_note_resolutions_v1'")
        .get()
    ) {
      scan.phase('references', surface, 'source_note_resolutions_v1');
      for (const row of database
        .prepare('SELECT data FROM source_note_resolutions_v1')
        .iterate() as Iterable<{ data: string }>) {
        scan.check();
        if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > MAX_RECORD_BYTES)
          throw new Error('维护备注处理记录超过读取上限或格式无效');
        references(JSON.parse(row.data), retained, scan);
        scan.state.recordsScanned++;
      }
    }
    for (const table of [
      'project_delivery_boards_v1',
      'project_delivery_manifests_v1',
      'project_delivery_links_v1',
    ]) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      scan.phase('references', surface, table);
      const column = table === 'project_delivery_links_v1' ? 'title' : 'data';
      for (const row of database.prepare(`SELECT ${column} value FROM ${table}`).iterate() as Iterable<{
        value: string;
      }>) {
        scan.check();
        if (typeof row.value !== 'string' || Buffer.byteLength(row.value) > MAX_RECORD_BYTES)
          throw new Error('维护项目交付记录超过读取上限或格式无效');
        references(column === 'data' ? JSON.parse(row.value) : row.value, retained, scan);
        scan.state.recordsScanned++;
      }
    }
    if (
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_delivery_archives_v1'")
        .get()
    ) {
      scan.phase('references', surface, 'project_delivery_archives_v1');
      for (const row of database
        .prepare(
          `SELECT a.object_ref,a.object_hash,a.manifest_hash,a.project_id,m.project_id manifest_project,m.hash frozen_hash
          FROM project_delivery_archives_v1 a LEFT JOIN project_delivery_manifests_v1 m ON m.id=a.manifest_id`,
        )
        .iterate() as Iterable<{
        object_ref: string;
        object_hash: string;
        manifest_hash: string;
        project_id: string;
        manifest_project: string;
        frozen_hash: string;
      }>) {
        scan.check();
        if (
          typeof row.object_ref !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.object_hash) ||
          row.object_ref.replace(/\\/g, '/') !==
            `objects/${row.object_hash.slice(0, 2)}/${row.object_hash}` ||
          row.manifest_hash !== row.frozen_hash ||
          row.project_id !== row.manifest_project
        )
          throw new Error('保存交付包引用无效，不能清理');
        references(row.object_ref, retained, scan);
        scan.state.recordsScanned++;
      }
    }
    scan.phase('references', surface, 'automation');
    for (const ref of automationReferenceClosure(directory, database, automationObjectReferences(database), {
      check: () => scan.check(),
      onBytes: (bytes) => {
        scan.state.bytesHashed += bytes;
      },
      onObject: (kind) => {
        scan.state.recordsScanned++;
        if (kind === 'file') scan.state.filesChecked++;
      },
    })) {
      scan.check();
      references(ref, retained, scan);
      scan.state.recordsScanned++;
    }
    scan.phase('references', surface, 'storage_meta');
    for (const row of database.prepare('SELECT key,value FROM storage_meta').iterate() as Iterable<{
      key: string;
      value: string;
    }>) {
      scan.check();
      if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES) throw new Error('维护元数据超过 64 MiB');
      scan.state.recordsScanned++;
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        if (row.key === 'local-agents:v1') throw new Error('本机代理库引用记录损坏，不能清理');
        continue;
      }
      references(value, retained, scan);
    }
    scan.phase('references', surface, 'compressed_objects');
    for (const row of database
      .prepare('SELECT ref,hash,raw_size,content FROM compressed_objects')
      .iterate() as Iterable<{ ref: string; hash: string; raw_size: number; content: Uint8Array }>) {
      scan.check();
      const bytes = decompress(row.content, scan);
      scan.state.recordsScanned++;
      if (hash(bytes) !== row.hash || bytes.length !== row.raw_size)
        throw new Error('压缩对象校验失败，不能清理');
      references(row.ref, retained, scan);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        continue;
      }
      references(value, retained, scan);
    }
    return { retained, database: databaseIdentity };
  } finally {
    database.close();
  }
}

/**
 * 核对规范哈希路径、真实父目录和普通单链接文件，分块计算摘要并比较读取前后身份；缺失返回 undefined，损坏或变化明确失败。
 * EN: Validates canonical hash path, real parents and regular single-link file, hashes chunks and compares before/after identity. Missing returns undefined; corruption/change fails explicitly.
 */
function checkedObject(directory: string, ref: string, scan: Scan): Candidate | undefined {
  scan.check();
  if (!objectPattern.test(ref)) throw new Error('无效对象路径');
  const [, prefix, name] = ref.split('/');
  if (name.slice(0, 2) !== prefix) throw new Error('对象目录与哈希不一致');
  const root = path.join(directory, 'objects');
  for (const parent of [root, path.join(root, prefix)]) {
    if (!existsSync(parent)) return;
    assertDirectory(parent);
    if (realpathSync(parent) !== parent) throw new Error('对象目录不能经过链接');
  }
  const filename = path.join(directory, ref);
  if (!existsSync(filename)) return;
  const before = identity(filename);
  const stat = lstatSync(filename);
  const file = openSync(filename, 'r');
  const checksum = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let length: number;
    while ((length = readSync(file, buffer, 0, buffer.length, null))) {
      checksum.update(buffer.subarray(0, length));
      scan.state.bytesHashed += length;
      scan.check();
    }
  } finally {
    closeSync(file);
  }
  if (checksum.digest('hex') !== name || identity(filename) !== before)
    throw new Error('对象内容或身份已变化');
  scan.state.filesChecked++;
  return { ref, bytes: stat.size, identity: before };
}

/**
 * 仅在持有两个服务锁时调用，CLI会先取得锁。 在双方入口锁下读取完整存活引用，再枚举规范内容寻址对象作为候选。 仅无引用且身份/内容可核验的普通文件入选；未知条目跳过，每入口最多列出 1000 项， truncated 明确表示还有未列出的候选，不能把计划当成已扫描到的全部可删文件。
 * EN: Call only while holding both service locks. The CLI acquires them before reaching here. Reads the complete live reference set under both locks, then enumerates canonical content-addressed objects. Only unreferenced, verifiable regular files are candidates; unknown entries are skipped. Each surface lists at most 1000 entries; truncated means more candidates exist, not a complete deletion inventory.
 */
export function createObjectCleanupPlan(
  directory: string,
  selection: Selection,
  options: ObjectMaintenanceOptions = {},
): Plan {
  const scan = new Scan(options);
  try {
    directory = realpathSync(directory);
    const surfaces: Surface[] =
      selection === 'all'
        ? (['native', 'terminal'] as const).filter((surface) =>
            existsSync(path.join(surfaceDirectory(directory, surface), 'state.db')),
          )
        : [selection];
    if (!surfaces.length) throw new Error('未找到可维护的数据库');
    const result: Plan['surfaces'] = [];
    for (const surface of surfaces) {
      assertSurfacePath(directory, surface);
      const target = surfaceDirectory(directory, surface);
      const state = readReferences(target, scan, surface);
      scan.phase('candidates', surface);
      const root = path.join(target, 'objects');
      const candidates: Candidate[] = [];
      let retained = 0,
        skipped = 0,
        truncated = false;
      if (existsSync(root)) {
        assertDirectory(root);
        for (const prefix of readdirSync(root).sort()) {
          scan.check();
          const prefixPath = path.join(root, prefix),
            stat = lstatSync(prefixPath);
          if (!/^[a-f0-9]{2}$/.test(prefix) || !stat.isDirectory() || stat.isSymbolicLink()) {
            skipped++;
            continue;
          }
          for (const name of readdirSync(prefixPath).sort()) {
            scan.check();
            const ref = `objects/${prefix}/${name}`;
            if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(prefix)) {
              skipped++;
              continue;
            }
            if (state.retained.has(ref)) {
              retained++;
              continue;
            }
            if (candidates.length >= 1000) {
              truncated = true;
              continue;
            }
            try {
              const item = checkedObject(target, ref, scan);
              if (item) {
                candidates.push(item);
                scan.state.totalCandidates++;
              }
            } catch (error) {
              if (error instanceof ObjectMaintenanceFailure) throw error;
              skipped++;
            }
          }
        }
      }
      result.push({
        surface,
        database: state.database,
        candidates,
        candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
        truncated,
        retained,
        skipped,
      });
    }
    scan.check(true);
    return {
      kind: 'elysia-object-cleanup',
      format: 1,
      appVersion: VERSION,
      createdAt: now(),
      scope: hash(directory),
      surfaces: result,
    };
  } catch (error) {
    return scan.failed(error);
  }
}

/**
 * 计划是显式选择，不是任意路径删除授权；首次unlink前， 重新核对所有选定对象和完整存活引用集合。 将计划当作显式选择而非删除权限：先重新读取全部引用、数据库身份和所有候选文件， 任何冲突都在第一次 unlink 前阻止执行；实际删除每一项前再核对身份/摘要。 删除前后分别写审计记录，取消不回滚已删除项，返回已完成的数量与剩余范围供恢复。
 * EN: A plan is an explicit selection, not authority to delete arbitrary paths. Recheck all selected objects and the complete live reference set before the first unlink. Treats plans as selection, not authority: rereads all references, database identity, and every candidate before unlink, rejecting conflicts first. Each deletion rechecks identity/digest and writes before/after audit records. Abort cannot undo deleted entries; results report completed counts and remaining scope.
 */
export function executeObjectCleanup(
  directory: string,
  supplied: unknown,
  selection: Selection,
  options: ObjectMaintenanceOptions = {},
): ObjectMaintenanceResult {
  const scan = new Scan(options);
  try {
    directory = realpathSync(directory);
    const plan = ObjectCleanupPlan.parse(supplied);
    scan.state.totalCandidates = plan.surfaces.reduce((sum, entry) => sum + entry.candidates.length, 0);
    if (plan.scope !== hash(directory)) throw new Error('维护计划属于另一数据目录');
    const surfaces = new Set<Surface>();
    const selected: { surface: Surface; target: string; candidate: Candidate }[] = [];
    for (const entry of plan.surfaces) {
      if (surfaces.has(entry.surface) || (selection !== 'all' && selection !== entry.surface))
        throw new Error('维护计划与所选入口不一致');
      surfaces.add(entry.surface);
      assertSurfacePath(directory, entry.surface);
      const target = surfaceDirectory(directory, entry.surface),
        state = readReferences(target, scan, entry.surface);
      options.beforePreflight?.();
      scan.check();
      scan.phase('preflight', entry.surface);
      if (state.database !== entry.database) throw new Error('数据库已被替换，请重新预览');
      const seen = new Set<string>();
      for (const candidate of entry.candidates) {
        if (seen.has(candidate.ref)) throw new Error('维护计划包含重复对象');
        seen.add(candidate.ref);
        if (state.retained.has(candidate.ref)) throw new Error('对象已有引用，请重新预览');
        const current = checkedObject(target, candidate.ref, scan);
        if (!current) {
          scan.audit({
            type: 'already-missing',
            surface: entry.surface,
            ref: candidate.ref,
            bytes: candidate.bytes,
          });
          scan.state.alreadyMissing++;
          continue;
        }
        if (current.identity !== candidate.identity || current.bytes !== candidate.bytes)
          throw new Error('对象已变化，请重新预览');
        selected.push({ surface: entry.surface, target, candidate });
      }
    }
    let priorSurface: Surface | undefined;
    /**
     * 所有入口预检完成才进入删除阶段，避免第二个入口有冲突时第一个入口已经部分删除。
     * EN: Completes preflight for all surfaces before deletion, preventing partial cleanup of the first when the second conflicts.
     */
    for (const { surface, target, candidate } of selected) {
      if (surface !== priorSurface) {
        scan.phase('delete', surface);
        priorSurface = surface;
      }
      /**
       * 删除此精确普通文件前立即重查身份与内容。
       * EN: Revalidate identity/content immediately before deleting this exact regular file.
       */
      const current = checkedObject(target, candidate.ref, scan);
      if (!current || current.identity !== candidate.identity)
        throw new Error('对象在清理期间发生变化，停止处理');
      scan.audit({ type: 'delete-started', surface, ref: candidate.ref, bytes: candidate.bytes });
      scan.check();
      unlinkSync(path.join(target, candidate.ref));
      scan.state.deleted++;
      scan.state.freedBytes += candidate.bytes;
      scan.audit({ type: 'delete-completed', surface, ref: candidate.ref, bytes: candidate.bytes });
      scan.check();
    }
    return scan.result('completed');
  } catch (error) {
    return scan.failed(error);
  }
}
