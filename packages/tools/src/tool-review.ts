import type { Attempt, Task, ToolCall } from '../../contracts/src/index.js';
import type { ToolReviewDecision, ToolReviewReceipt } from '../../contracts/src/execution-policy.js';

export interface ToolReviewInput {
  task: Task;
  attempt: Attempt;
  call: ToolCall;
  args: Record<string, unknown>;
  assistantMessageId: string;
  fingerprint: string;
  context: Record<string, unknown>;
}
export type ReviewModel = (input: ToolReviewInput, signal: AbortSignal) => Promise<ToolReviewReceipt>;

/** A small deterministic filter, not a parser or a process sandbox. */
export function reviewToolRules(name: string, args: Record<string, unknown>): ToolReviewDecision {
  if (name !== 'exec') return { decision: 'allow', reason: '继续执行已有工具授权与路径校验' };
  const program = String(args.program)
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/, '');
  const command = [program, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ');
  if (
    ['rm', 'rmdir', 'del', 'format', 'mkfs', 'diskpart', 'shutdown', 'reboot'].includes(program) ||
    /(?:^|[\s;&|])(remove-item|format-volume|clear-disk)\b/i.test(command) ||
    /\bgit\s+(?:push|reset\s+--hard|clean\s+-\w*f)/i.test(command) ||
    /(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell)/i.test(command)
  )
    return {
      decision: 'deny',
      reason: '规则审核拦截破坏性、发布或下载后直接执行的命令；请改为可核验的分步操作',
    };
  return { decision: 'allow', reason: '规则未命中；执行仍受原权限和所选命令后端限制' };
}
