/**
 * 按协议与认证方式注册并选择供应商适配器。
 * 每次请求获得独立绑定副本，凭据能力按具体绑定延迟提供，注册本身不连接模型。
 *
 * EN: Registers and selects provider adapters by protocol and authentication.
 * Each request receives its own binding copy and deferred credential capability; registration makes no model connection.
 */
import { AppError, type ProviderConfig } from '../../contracts/src/index.js';
import { PluginRegistry, type PluginContributions } from '../../plugins/src/index.js';
import { NativeProvider, type ProviderAdapter } from './native.js';

export type ProviderFactory = (binding: ProviderConfig) => ProviderAdapter;
export type ProviderPlugin = PluginContributions<ProviderFactory>;
export type ProviderCredential = NonNullable<ConstructorParameters<typeof NativeProvider>[1]>;

/**
 * 按协议/认证精确匹配，防止静默回退到其他账号或传输。
 *
 * EN: Exact protocol/authentication matching prevents silent fallback to another account or transport.
 */
export class ProviderRegistry {
  private readonly plugins: PluginRegistry<ProviderFactory>;
  /** 用固定的供应商贡献构造不可变注册表，重复身份/贡献名由共享注册表拒绝。
   * EN: Builds an immutable registry from fixed provider contributions; the shared registry rejects duplicate identities/names.
   */
  constructor(plugins: readonly ProviderPlugin[]) {
    this.plugins = new PluginRegistry(plugins);
  }
  /**
   * 用协议与认证方式组成贡献键，并为本次适配器提供独立绑定副本；未注册即明确失败。
   *
   * EN: Builds a contribution key from protocol/authentication and gives each adapter an independent binding copy; missing registration fails explicitly.
   */
  adapter(binding: ProviderConfig): ProviderAdapter {
    /**
     * 只有完全匹配的协议和认证方式才能创建适配器，不回退到其他连接。
     *
     * EN: Only an exact protocol/authentication match can create an adapter; no fallback to another connection occurs.
     */
    const key = `${binding.kind}:${binding.authMode ?? 'apiKey'}`;
    const create = this.plugins.get(key);
    if (!create) throw new AppError('PROVIDER_PLUGIN_MISSING', `未注册模型接入插件：${key}`);
    /**
     * 每次请求得到独立冻结绑定副本，适配器不拥有其他代理的型号选择。
     *
     * EN: Each request receives its own frozen binding copy; an adapter never owns another agent's choice.
     */
    return create(structuredClone(binding));
  }
  /**
   * 返回只读插件清单，用于能力展示和装配诊断，不触发连接或模型请求。
   *
   * EN: Returns a read-only plugin manifest for capabilities and diagnostics without connecting or requesting a model.
   */
  describe() {
    return this.plugins.describe();
  }
}

/**
 * 注册两种 API 密钥接入；凭据由宿主按具体绑定提供。
 *
 * EN: Registers two API-key adapters; the host supplies credentials for the concrete binding.
 */
export function nativeProviderPlugins(
  credential?: (binding: ProviderConfig) => ProviderCredential | undefined,
): ProviderPlugin[] {
  return (['openai', 'deepseek'] as const).map((kind) => ({
    manifest: { id: `provider.${kind}`, version: '1.0.0', apiVersion: 1 },
    contributions: {
      /** 每次调用创建独立适配器，并把具体绑定传给宿主凭据能力选择器。
       * EN: Creates a separate adapter per call and passes its concrete binding to the host credential-capability selector.
       */
      [`${kind}:apiKey`]: (binding: ProviderConfig) => new NativeProvider(binding, credential?.(binding)),
    },
  }));
}
