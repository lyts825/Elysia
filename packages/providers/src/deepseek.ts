// 识别官方 DeepSeek 路由及其模型兼容问题。
import type { ProviderConfig } from '../../contracts/src/index.js';

/** Scope official API policy to the route, never to a third-party model name. */
export function officialDeepSeek(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean {
  try {
    const url = new URL(provider.baseUrl);
    // 同时接受官方根路径、v1 路径和对应的补全端点。
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return (
      provider.kind === 'deepseek' && url.origin === 'https://api.deepseek.com' && ['', '/v1'].includes(path)
    );
  } catch {
    return false;
  }
}

/** Explicit migration keeps the old alias's thinking policy without changing saved tasks. */
export function deepSeekModelReplacement(
  provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model' | 'reasoningEffort'>,
): Pick<ProviderConfig, 'model' | 'reasoningEffort'> | undefined {
  if (!officialDeepSeek(provider)) return undefined;
  if (provider.model === 'deepseek-chat') return { model: 'deepseek-flash', reasoningEffort: 'none' };
  if (provider.model === 'deepseek-reasoner')
    return { model: 'deepseek-flash', reasoningEffort: provider.reasoningEffort ?? 'high' };
  return undefined;
}

export function retiredDeepSeekModelIssue(
  provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model' | 'reasoningEffort'>,
): string {
  // 仅提供提示，不在读取旧配置时自动迁移任务或模型。
  return deepSeekModelReplacement(provider)
    ? `DeepSeek 官方旧型号「${provider.model}」已停用，请将连接切换为 deepseek-flash，保存并重新验证。`
    : '';
}
