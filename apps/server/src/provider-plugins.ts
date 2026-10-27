/** 组装服务端使用的模型服务商插件。 */
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
 * 在服务边界注入 API 密钥和订阅凭据能力，按协议/认证方式精确注册适配器。
 * 配置编译时不提前读取密钥；实际请求时通过闭包取冻结绑定的凭据，避免运行时直接访问账号服务。
 */
/** Server-owned account capabilities stay out of the runtime and of the terminal surface. */
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
        'openai:chatgpt': (binding: ProviderConfig) =>
          new NativeProvider(binding, () => services.subscription.credential(binding.subscriptionAccountId!)),
      },
    },
    {
      manifest: { id: 'provider.codex', version: '1.0.0', apiVersion: 1 },
      contributions: {
        'openai:codex': (binding: ProviderConfig) => services.codex.adapter(binding),
      },
    },
  ]);
}
