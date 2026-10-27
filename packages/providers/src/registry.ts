// 按协议与认证方式注册并选择供应商适配器。
import { AppError, type ProviderConfig } from '../../contracts/src/index.js';
import { PluginRegistry, type PluginContributions } from '../../plugins/src/index.js';
import { NativeProvider, type ProviderAdapter } from './native.js';

export type ProviderFactory = (binding: ProviderConfig) => ProviderAdapter;
export type ProviderPlugin = PluginContributions<ProviderFactory>;
export type ProviderCredential = NonNullable<ConstructorParameters<typeof NativeProvider>[1]>;

/** Exact protocol/authentication matching prevents silent fallback to another account or transport. */
export class ProviderRegistry {
  private readonly plugins: PluginRegistry<ProviderFactory>;
  constructor(plugins: readonly ProviderPlugin[]) {
    this.plugins = new PluginRegistry(plugins);
  }
  adapter(binding: ProviderConfig): ProviderAdapter {
    // 只有完全匹配的协议和认证方式才能创建适配器，不回退到其他连接。
    const key = `${binding.kind}:${binding.authMode ?? 'apiKey'}`;
    const create = this.plugins.get(key);
    if (!create) throw new AppError('PROVIDER_PLUGIN_MISSING', `未注册模型接入插件：${key}`);
    // Each request receives its own frozen binding copy; an adapter never owns another agent's choice.
    return create(structuredClone(binding));
  }
  describe() {
    return this.plugins.describe();
  }
}

/** 注册两种 API 密钥接入；凭据由宿主按具体绑定提供。 */
export function nativeProviderPlugins(
  credential?: (binding: ProviderConfig) => ProviderCredential | undefined,
): ProviderPlugin[] {
  return (['openai', 'deepseek'] as const).map((kind) => ({
    manifest: { id: `provider.${kind}`, version: '1.0.0', apiVersion: 1 },
    contributions: {
      [`${kind}:apiKey`]: (binding: ProviderConfig) => new NativeProvider(binding, credential?.(binding)),
    },
  }));
}
