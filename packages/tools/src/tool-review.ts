/**
 * 根据工具和参数计算工具调用的审核决策。
 * EN: Compute tool-review decisions from tool identity and parsed arguments.
 *
 * 将参数与工具策略结合生成审核要求，供执行前门禁使用；审核结论与真实执行结果分别记录，不能互相替代。
 * EN: Combine parsed arguments and policy into pre-execution review requirements; review decisions and actual execution outcomes remain distinct records.
 */
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

/**
 * 对 exec 的程序名与参数应用有限的确定性拦截规则。
 * 规则允许只表示未命中已知模式；后续授权、路径限制及命令后端仍须执行检查。
 * 该函数不是完整命令解析器，也不能代替进程隔离。
 * EN: Apply a limited deterministic filter to exec program names and arguments. Allow means no known
 * rule matched; authorization, path checks, and the selected backend still apply. This is neither a
 * complete command parser nor process isolation.
 */
export function reviewToolRules(name: string, args: Record<string, unknown>): ToolReviewDecision {
  if (name !== 'exec' && name !== 'job_start')
    return { decision: 'allow', reason: '继续执行已有工具授权与路径校验' };
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
