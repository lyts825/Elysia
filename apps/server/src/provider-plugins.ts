/**
 * 组装服务端使用的模型服务商插件。
 * 按协议/认证注册适配器，请求时通过闭包取冻结凭据；账号能力由服务端持有，终端和运行时不直接读取原生保险库。
 * EN: Assembles server-side model provider plugins. Registers adapters by protocol/auth and resolves frozen credentials at request time; server retains account capabilities outside terminal/runtime vault access.
 */
import type { ProviderConfig } from '../../../packages/contracts/src/index.js';
import {
  NativeProvider,
  ProviderRegistry,
  nativeProviderPlugins,
} from '../../../packages/providers/src/index.js';
import type { CodexSubscription } from './codex-subscription.js';
import type { SubscriptionService } from './subscription.js';
import type { ProviderKeys } from './provider-keys.js';

/**
 * 在服务边界注入 API 密钥和订阅凭据能力，按协议/认证方式精确注册适配器。 配置编译时不提前读取密钥；实际请求时通过闭包取冻结绑定的凭据，避免运行时直接访问账号服务。 账号能力由服务端持有，不进入运行时或终端入口。
 * EN: Injects API-key and subscription capabilities at the server boundary and registers adapters by exact protocol/auth pairing. Compilation does not read secrets; request-time closures resolve frozen bindings so runtime never accesses account services directly. Server-owned account capabilities stay out of the runtime and of the terminal surface.
 */
export function serverProviderPlugins(services: {
  codex: Pick<CodexSubscription, 'adapter'>;
  subscription: Pick<SubscriptionService, 'credential'>;
  keys: Pick<ProviderKeys, 'credential'>;
}) {
  return new ProviderRegistry([
    ...nativeProviderPlugins((binding) =>
      binding.credentialId ? () => services.keys.credential(binding) : undefined,
    ),
    {
      manifest: { id: 'provider.chatgpt', version: '1.0.0', apiVersion: 1 },
      contributions: {
        /**
         * 为冻结 ChatGPT 绑定创建原生适配器，请求时才向订阅服务取得账号凭据和取消能力。
         * EN: Creates a native adapter for a frozen ChatGPT binding, resolving account credentials/cancellation only at request time.
         */
        'openai:chatgpt': (binding: ProviderConfig) =>
          new NativeProvider(binding, () => services.subscription.credential(binding.subscriptionAccountId!)),
      },
    },
    {
      manifest: { id: 'provider.codex', version: '1.0.0', apiVersion: 1 },
      contributions: {
        /**
         * 将冻结 Codex 配置委托给服务端订阅桥，运行时不直接读取 CLI 账号。
         * EN: Delegates frozen Codex configuration to the server subscription bridge without runtime CLI-account access.
         */
        'openai:codex': (binding: ProviderConfig) => services.codex.adapter(binding),
      },
    },
  ]);
}
