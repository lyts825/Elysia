/**
 * 注册通过网络获取内容的工具。
 * EN: Register network content-fetching tools.
 *
 * 声明网络工具的参数、权限和执行适配，实际请求及结果限制由注入服务提供，便于统一审核和结果登记。
 * EN: Declare network tool inputs, permissions, and adapters while injected services perform bounded requests for shared review and result recording.
 */
import { z } from 'zod';

import { defineTool, type ToolServices, type ToolInvocation, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';

const schemas = { fetch_url: z.object({ url: z.string().url() }) };
/**
 * 注册 fetch_url：参数先经 URL 校验，具体授权、地址检查和快照由网关执行。
 * EN: Register fetch_url with URL-shape validation; the gateway performs exact authorization,
 * address checks, and snapshot persistence.
 */
export function networkTools(context: Pick<ToolServices, 'fetch'>): PluginContributions<ToolContribution> {
  /**
   * 把任务、URL和取消信号交给已授权网关抓取服务。
   * EN: Pass task, URL, and cancellation to the authorized gateway fetch service.
   */
  async function execute_fetch_url(
    { task, signal }: ToolInvocation,
    args: z.output<typeof schemas.fetch_url>,
  ) {
    return await context.fetch(task, args.url, signal);
  }
  return {
    manifest: { id: 'tools.network', version: '1.0.0', apiVersion: 1 },
    contributions: {
      fetch_url: defineTool(
        'fetch_url',
        schemas.fetch_url,
        '获取合同明确授权的 HTTP(S) URL 并记录快照；禁止私网，重定向也须授权。不是搜索引擎，失败不代表已读到页面。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_fetch_url,
      ),
    },
  };
}
