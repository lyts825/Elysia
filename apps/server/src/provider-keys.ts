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
  async configured(p: ProviderConfig) {
    if (!p.credentialId) return !!process.env[p.apiKeyEnv];
    try {
      return !!(await this.load()).keys[p.credentialId];
    } catch {
      return false;
    }
  }
  async credential(p: ProviderConfig) {
    const token = p.credentialId ? (await this.load()).keys[p.credentialId] : process.env[p.apiKeyEnv];
    invariant(token, 'API_KEY_MISSING', '请保存 API Key 或配置所选环境变量');
    return { token, signal: new AbortController().signal };
  }
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
