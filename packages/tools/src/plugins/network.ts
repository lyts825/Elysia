import { z } from 'zod';

import { defineTool, type ToolServices, type ToolInvocation, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';

const schemas = { fetch_url: z.object({ url: z.string().url() }) };
export function networkTools(context: Pick<ToolServices, 'fetch'>): PluginContributions<ToolContribution> {
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
