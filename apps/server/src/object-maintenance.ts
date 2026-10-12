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
  // The worker atomically closes its read-only termination gate before any cleanup preflight.
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
  constructor(public reason: ObjectMaintenanceResult['failureReason']) {
    super('对象维护已停止');
  }
}
export class ObjectMaintenanceFailure extends Error {
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
  constructor(private options: ObjectMaintenanceOptions) {}
  phase(phase: ObjectMaintenancePhase, surface: Surface, table?: string) {
    Object.assign(this.state, { phase, surface, table });
    this.surfaces.add(surface);
    this.audit({ type: 'phase', phase, surface, ...(table ? { table } : {}) });
    this.check(true);
  }
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
  audit(event: ObjectMaintenanceAudit) {
    try {
      this.options.onAudit?.(event);
    } catch {
      throw new MaintenanceProblem('audit_write_failed');
    }
  }
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
// Fail closed for unusually large/corrupt records; never skip a reference-bearing value.
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 1_000_000;
function decompress(content: Uint8Array, scan: Scan) {
  scan.check();
  if (content.byteLength > MAX_RECORD_BYTES) throw new Error('维护记录超过 64 MiB，已停止且未跳过引用');
  const bytes = gunzipSync(content, { maxOutputLength: MAX_RECORD_BYTES });
  scan.check();
  return bytes;
}

function identity(file: string, database = false) {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error('对象维护不能处理链接或特殊文件');
  return hash(database ? `${stat.dev}:${stat.ino}` : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`);
}

// Retain every object-looking string, including objects referenced by retained historical
// snapshots and compressed text. This deliberately errs on the side of keeping extra files.
function references(value: unknown, retained: Set<string>, scan: Scan) {
  let visited = 0;
  const visit = (item: unknown) => {
    if ((visited++ & 255) === 0) scan.check();
    if (typeof item === 'string') {
      // A normalized object ref always has this exact length; avoid scanning large text twice.
      if (item.length !== 75) return;
      const ref = item.replaceAll('\\', '/');
      if (objectPattern.test(ref)) {
        retained.add(ref);
        if (retained.size > MAX_REFERENCES) throw new Error('维护引用超过 100 万条，已停止且未跳过引用');
      }
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item && typeof item === 'object') {
      // JSON values only have own enumerable properties. Do not allocate every value up front.
      for (const key in item) if (Object.hasOwn(item, key)) visit((item as Record<string, unknown>)[key]);
    }
  };
  visit(value);
  scan.check();
}

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

// Call only while holding both service locks. The CLI acquires them before reaching here.
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

// A plan is an explicit selection, not authority to delete arbitrary paths. Recheck all
// selected objects and the complete live reference set before the first unlink.
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
    for (const { surface, target, candidate } of selected) {
      if (surface !== priorSurface) {
        scan.phase('delete', surface);
        priorSurface = surface;
      }
      // Revalidate identity/content immediately before deleting this exact regular file.
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
