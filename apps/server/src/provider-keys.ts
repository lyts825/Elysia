/**
 * 管理服务商凭据的读取和保存。
 * 通过系统保险库或明确环境引用解析密钥，串行轮换在落盘成功后发布新 ID；旧绑定保留，不改既有任务或删除旧密钥。
 * EN: Reads and saves provider credentials. Resolves vault/environment keys and serializes rotation, publishing new IDs after persistence while retaining old bindings/keys for existing runs.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import type { DesktopServices } from './desktop.js';

const Vault = z.object({
  version: z.literal(1),
  keys: z.record(z.string().uuid(), z.string().min(1).max(8192)),
});
export class ProviderKeys {
  private loaded?: Promise<z.infer<typeof Vault>>;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 绑定可选操作系统保险库桌面能力；首次读取时才初始化内存凭据缓存。
   * EN: Binds optional desktop OS-vault capability; credential memory cache initializes on first read.
   */
  constructor(private desktop?: DesktopServices) {}
  /**
   * 合并首次保险库读取；失败清除缓存，后续操作可在系统密钥环恢复后重新尝试。
   * EN: Coalesces the first vault read; failures clear the cached promise so later operations may retry after keyring recovery.
   */
  private async load() {
    invariant(this.desktop, 'DESKTOP_REQUIRED', '加密保存密钥需要桌面入口；也可使用环境变量');
    return (this.loaded ??= this.desktop
      .request('key-vault-read')
      .then((v) => Vault.parse(v || { version: 1, keys: {} }))
      .catch((e) => {
        this.loaded = undefined;
        throw e;
      }));
  }
  /**
   * 检查凭据引用或配置的环境变量是否有值；读取保险库失败按未配置显示。
   * EN: Checks credential references or configured environment variables; vault read failure is shown as unconfigured.
   */
  async configured(p: ProviderConfig) {
    if (!p.credentialId) return !!process.env[p.apiKeyEnv];
    try {
      return !!(await this.load()).keys[p.credentialId];
    } catch {
      return false;
    }
  }
  /**
   * 解析模型绑定的密钥；缺失时抛出 API_KEY_MISSING。
   * EN: Resolves a model's bound key or throws API_KEY_MISSING.
   */
  async credential(p: ProviderConfig) {
    const token = p.credentialId ? (await this.load()).keys[p.credentialId] : process.env[p.apiKeyEnv];
    invariant(token, 'API_KEY_MISSING', '请保存 API Key 或配置所选环境变量');
    return { token, signal: new AbortController().signal };
  }
  /**
   * 串行写入保险库并返回新的不可变凭据 ID。只有系统保存成功才更新内存缓存， 轮换保留旧 ID，使已有任务继续使用其冻结引用；此处不重写旧任务或删除旧密钥。
   * EN: Serializes vault writes and returns a new immutable credential ID. Memory changes only after OS persistence succeeds; rotation retains old IDs for frozen run bindings without rewriting runs or deleting old keys.
   */
  save(key: string): Promise<string> {
    const result = this.queue.then(async () => {
      const vault = await this.load(),
        id = randomUUID();
      const next = { ...vault, keys: { ...vault.keys, [id]: z.string().trim().min(1).max(8192).parse(key) } };
      await this.desktop!.request('key-vault-write', next);
      this.loaded = Promise.resolve(next);
      /**
       * 轮换生成新的引用；运行中的代理继续使用原来的凭据绑定。
       * EN: Rotation gets a new reference; running agents retain their original credential binding.
       */
      return id;
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
