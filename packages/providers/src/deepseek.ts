/**
 * 识别官方 DeepSeek 路由及其模型兼容问题。
 * 只对官方路由应用明确兼容规则，第三方同名模型不自动受到官方策略改写。
 *
 * EN: Recognizes official DeepSeek routes and their model-compatibility issues.
 * Applies compatibility policy only to official routes, without rewriting third-party models sharing a name.
 */
import type { ProviderConfig } from '../../contracts/src/index.js';

/**
 * 官方 API 策略按路由限定，不按第三方型号名称推断。
 *
 * EN: Scope official API policy to the route, never to a third-party model name.
 */
export function officialDeepSeek(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean {
  try {
    const url = new URL(provider.baseUrl);
    /**
     * 同时接受官方根路径、v1 路径和对应的补全端点。
     *
     * EN: Accepts official root, v1 paths, and their completion endpoints.
     */
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return (
      provider.kind === 'deepseek' && url.origin === 'https://api.deepseek.com' && ['', '/v1'].includes(path)
    );
  } catch {
    return false;
  }
}

/**
 * 显式迁移保留旧别名的思考策略，不改变已保存任务。
 *
 * EN: Explicit migration keeps the old alias's thinking policy without changing saved tasks.
 */
export function deepSeekModelReplacement(
  provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model' | 'reasoningEffort'>,
): Pick<ProviderConfig, 'model' | 'reasoningEffort'> | undefined {
  if (!officialDeepSeek(provider)) return undefined;
  if (provider.model === 'deepseek-chat') return { model: 'deepseek-flash', reasoningEffort: 'none' };
  if (provider.model === 'deepseek-reasoner')
    return { model: 'deepseek-flash', reasoningEffort: provider.reasoningEffort ?? 'high' };
  return undefined;
}

/**
 * 返回显式迁移提示或空字符串；读取/编译旧配置时不会在这里替换保存的型号。
 *
 * EN: Returns explicit migration guidance or an empty string; reading/compiling old settings never replaces their stored model here.
 */
export function retiredDeepSeekModelIssue(
  provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model' | 'reasoningEffort'>,
): string {
  /**
   * 仅提供提示，不在读取旧配置时自动迁移任务或模型。
   *
   * EN: Provides guidance only; it does not migrate tasks or models while reading old settings.
   */
  return deepSeekModelReplacement(provider)
    ? `DeepSeek 官方旧型号「${provider.model}」已停用，请将连接切换为 deepseek-flash，保存并重新验证。`
    : '';
}
