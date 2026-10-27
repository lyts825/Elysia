// 模型请求、工具定义及提供方适配器的共享契约。
import { AppError, inspectToolCalls, type ToolCall, type Usage, type Message } from './index.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompiledContext {
  /** 传给模型的系统规则、当前任务、已配对历史和允许使用的工具。 */
  system: string;
  task: string;
  history: Message[];
  tools: ToolDefinition[];
  manifest: Record<string, unknown>;
  estimatedTokens: number;
}
/** 在发起模型请求前拒绝无效或尚未结束的工具调用序列。 */
export function validatePairs(messages: Message[]) {
  const sequence = inspectToolCalls(messages);
  if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
  if (sequence.pending.length) throw new AppError('TOOL_PAIR_INCOMPLETE', '工具调用结果缺失');
}
export class ProviderError extends AppError {
  /** 一旦收到响应内容，调用方需要谨慎处理重试，避免把部分结果当成全新请求。 */
  responseStarted = false;
  /** 失败时已知的供应商用量；null 表示没有可用的用量信息。 */
  usage: Usage | null = null;
  constructor(
    code: string,
    message: string,
    public status: number,
    public retryAfterMs = 0,
  ) {
    super(code, message, status === 429 || status >= 500 || status === 0);
  }
}
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning_delta'; text: string; kind: 'reasoning_content' }
  | {
      type: 'completed';
      text: string;
      calls: ToolCall[];
      usage: Usage | null;
      native: unknown[];
      reasoningContent?: string;
    };
export interface ProviderAdapter {
  /** 接入层声明能力；compile 将共享上下文映射为具体协议，stream 逐步产出事件。 */
  capabilities: { streaming: boolean; tools: boolean; nativeReplay: boolean };
  compile(context: CompiledContext): Record<string, unknown>;
  stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}
