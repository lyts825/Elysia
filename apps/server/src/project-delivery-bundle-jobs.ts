/**
 * 保存并读取项目交付打包任务。
 * 管理专属临时目录及 owner 标记，每次使用重查真实路径/归属；只有证明属于本数据目录的遗留才能清理，未知内容保留。
 * EN: Stores and reads project-delivery bundle jobs. Owns temporary directories/markers with repeated realpath/ownership checks; only proven owned residues are cleaned and unknown content remains.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../../packages/contracts/src/index.js';
import { hash } from '../../../packages/storage/src/index.js';

const rootSchema = z
  .object({
    version: z.literal(1),
    service: z.literal('elysia-project-delivery-bundle'),
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().uuid(),
  })
  .strict();
const markerSchema = rootSchema
  .extend({
    jobId: z.string().uuid(),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    projectId: z.string().uuid(),
    manifestId: z.string().uuid(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Marker = z.infer<typeof markerSchema>;
/**
 * 按平台比较规范路径，Windows 忽略大小写，供临时目录身份核验。
 * EN: Compares normalized paths with Windows case-insensitivity for temporary-directory identity checks.
 */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * 构造临时包存储无法安全使用的可重试错误，不暴露底层文件路径。
 * EN: Creates a retryable error for unsafe/unavailable temporary bundle storage without exposing underlying paths.
 */
const unavailable = () =>
  new AppError(
    'PROJECT_BUNDLE_STORAGE',
    '文件包临时目录无法安全使用，请重试或重新启动本机服务',
    true,
    null,
    503,
  );

/**
 * 只检查新建的服务归属命名空间，不扫描旧临时目录。 为交付包后台任务管理受所有者标记保护的临时目录。
 * EN: Only this new, service-owned namespace is inspected. Legacy temp directories are never scanned. Manages temporary bundle-job directories protected by ownership markers.
 */
export class BundleJobStorage {
  readonly instanceId = randomUUID();
  readonly ready: Promise<void>;
  private root!: string;
  private owner!: z.infer<typeof rootSchema>;
  /**
   * 启动一次临时存储初始化并保留 ready 承诺；预先接住拒绝以免未被等待时产生未处理异常，调用方仍可等待同一失败。
   * EN: Starts one initialization and retains ready, attaching a rejection handler to prevent unhandled rejection while callers still observe the same failure.
   */
  constructor(private storeDirectory: string) {
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  /**
   * 校验路径为期望的普通文件或目录且 realpath 与声明一致，拒绝链接/特殊文件并返回 stat。
   * EN: Validates expected regular-file/directory type and matching realpath, rejecting links/special files before returning stat.
   */
  private async plain(filename: string, directory: boolean) {
    const stat = await fs.lstat(filename);
    if (
      stat.isSymbolicLink() ||
      !(directory ? stat.isDirectory() : stat.isFile()) ||
      !samePath(await fs.realpath(filename), path.resolve(filename))
    )
      throw unavailable();
    return stat;
  }
  /**
   * 只读取不超过 8KiB 的已核验普通 JSON 元数据；解析或身份错误直接失败。
   * EN: Reads only verified regular JSON metadata up to 8KiB, propagating parse/identity errors.
   */
  private async json(filename: string) {
    const stat = await this.plain(filename, false);
    if (stat.size > 8192) throw unavailable();
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  }
  /**
   * 重新核对临时根及 owner.json 与本实例的归属记录一致，避免后续操作误用替换目录。
   * EN: Rechecks temporary root and owner.json against this instance's ownership to reject replaced directories.
   */
  private async rootValid() {
    await this.plain(this.root, true);
    const current = rootSchema.parse(await this.json(path.join(this.root, 'owner.json')));
    if (JSON.stringify(current) !== JSON.stringify(this.owner)) throw unavailable();
  }
  /**
   * 只认领本服务命名空间和已存在的有效 owner 标记；旧未知临时目录不接管。 启动时仅清理可证明 PID 已不存在且完整归属匹配的作业，PID 复用或权限不明保守保留。
   * EN: Claims only this service namespace with valid existing owner markers, never unknown legacy directories. Startup cleans only provably dead-PID jobs with matching ownership; PID reuse and uncertain permissions are conservatively retained.
   */
  private async initialize() {
    try {
      const store = await fs.realpath(this.storeDirectory);
      this.root = path.join(store, '.delivery-bundle-jobs-v1');
      let created = false;
      await fs
        .mkdir(this.root, { mode: 0o700 })
        .then(() => {
          created = true;
        })
        .catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      await this.plain(this.root, true);
      const filename = path.join(this.root, 'owner.json');
      const expected = {
        version: 1 as const,
        service: 'elysia-project-delivery-bundle' as const,
        storeHash: hash(store),
        owner: randomUUID(),
      };
      if (created) await fs.writeFile(filename, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
      /**
       * 已有但无标记的命名空间不自动认领；短暂等待， 并发创建者写完标记，否则保持原状。
       * EN: An existing unmarked namespace is not ours to claim. Briefly allow a concurrent creator to finish its marker, otherwise leave it unchanged.
       */
      for (let attempt = 0; ; attempt++) {
        try {
          this.owner = rootSchema.parse(await this.json(filename));
          break;
        } catch (error) {
          if (attempt >= 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (this.owner.storeHash !== expected.storeHash) throw unavailable();
      /**
       * PID复用与权限错误均刻意视为活动或未知。
       * EN: PID reuse and permission errors are deliberately treated as live/unknown.
       */
      for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(this.root, entry.name);
        try {
          const marker = await this.owned(directory);
          let dead = false;
          try {
            process.kill(marker.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (dead) await this.remove(directory, marker);
        } catch {
          /**
           * 未知、变更、链接及其他活动实例目录均不修改。
           * EN: Unknown, changed, linked and active-instance directories remain untouched.
           */
        }
      }
    } catch {
      throw unavailable();
    }
  }
  /**
   * 根标记、直属目录名和作业字段共同证明归属；出现 job.json/delivery.zip 之外内容即拒绝清理。
   * EN: Root marker, direct directory name, and job fields jointly prove ownership; anything beyond job.json/delivery.zip rejects cleanup.
   */
  private async owned(directory: string) {
    await this.rootValid();
    if (!samePath(path.dirname(path.resolve(directory)), this.root)) throw unavailable();
    await this.plain(directory, true);
    const marker = markerSchema.parse(await this.json(path.join(directory, 'job.json')));
    if (
      marker.owner !== this.owner.owner ||
      marker.storeHash !== this.owner.storeHash ||
      path.basename(directory) !== `job-${marker.jobId}-${marker.instanceId}`
    )
      throw unavailable();
    const entries = await fs.readdir(directory);
    if (entries.some((name) => name !== 'job.json' && name !== 'delivery.zip')) throw unavailable();
    for (const name of entries) await this.plain(path.join(directory, name), false);
    return marker;
  }
  /**
   * 删除前重新核对所有标记，只 unlink 两个已知平面文件，不递归跟随不可信子树。
   * EN: Rechecks all markers before deletion and unlinks only two known flat files, never recursively following untrusted subtrees.
   */
  private async remove(directory: string, expected: Marker) {
    const marker = await this.owned(directory);
    if ((Object.keys(marker) as (keyof Marker)[]).some((key) => marker[key] !== expected[key]))
      throw unavailable();
    /**
     * 仅处理已知平面文件，不递归删除不可信子树。
     * EN: Flat known files only: no recursive deletion can follow an untrusted subtree.
     */
    await fs.unlink(path.join(directory, 'delivery.zip')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.unlink(path.join(directory, 'job.json'));
    await fs.rmdir(directory);
  }
  /**
   * 建立当前服务实例专属目录并返回 ZIP 路径与精确清理函数，调用方仍负责生成和验证正文。
   * EN: Creates a directory owned by this service instance and returns its ZIP path and exact cleanup function; callers still generate and verify content.
   */
  async create(binding: Pick<Marker, 'jobId' | 'projectId' | 'manifestId' | 'manifestHash' | 'sessionHash'>) {
    await this.ready;
    await this.rootValid();
    const marker: Marker = { ...this.owner, ...binding, instanceId: this.instanceId, pid: process.pid };
    const directory = path.join(this.root, `job-${marker.jobId}-${marker.instanceId}`);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    return { filename: path.join(directory, 'delivery.zip'), /**
       * 使用本次目录和标记移除其专属临时包文件，删除资格仍由 remove 复核。
       * EN: Removes this job's temporary directory/marker through remove's ownership revalidation.
       */
      dispose: () => this.remove(directory, marker) };
  }
}
