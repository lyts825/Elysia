/** 管理服务商凭据的读取和保存。 */
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
  constructor(private desktop?: DesktopServices) {}
  /** 合并首次保险库读取；失败清除缓存，后续操作可在系统密钥环恢复后重新尝试。 */
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
  /** 检查凭据引用或配置的环境变量是否有值；读取保险库失败按未配置显示。 */
  async configured(p: ProviderConfig) {
    if (!p.credentialId) return !!process.env[p.apiKeyEnv];
    try {
      return !!(await this.load()).keys[p.credentialId];
    } catch {
      return false;
    }
  }
  /** 解析模型绑定的密钥；缺失时抛出 API_KEY_MISSING。 */
  async credential(p: ProviderConfig) {
    const token = p.credentialId ? (await this.load()).keys[p.credentialId] : process.env[p.apiKeyEnv];
    invariant(token, 'API_KEY_MISSING', '请保存 API Key 或配置所选环境变量');
    return { token, signal: new AbortController().signal };
  }
  /**
   * 串行写入保险库并返回新的不可变凭据 ID。只有系统保存成功才更新内存缓存，
   * 轮换保留旧 ID，使已有任务继续使用其冻结引用；此处不重写旧任务或删除旧密钥。
   */
  save(key: string): Promise<string> {
    const result = this.queue.then(async () => {
      const vault = await this.load(),
        id = randomUUID();
      const next = { ...vault, keys: { ...vault.keys, [id]: z.string().trim().min(1).max(8192).parse(key) } };
      await this.desktop!.request('key-vault-write', next);
      this.loaded = Promise.resolve(next);
      // Rotation gets a new reference; running agents retain their original credential binding.
      return id;
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
