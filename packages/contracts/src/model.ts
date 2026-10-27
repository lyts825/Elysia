/**
 * 模型请求、工具定义及提供方适配器的共享契约。
 * 把无副作用协议编译与带取消/用量事件的实际流请求分离，方便宿主统一核验和计费。
 *
 * EN: Defines shared model requests, tool definitions, and provider-adapter contracts.
 * Separates pure protocol compilation from cancellable usage-reporting streams for host verification/accounting.
 */
import { AppError, inspectToolCalls, type ToolCall, type Usage, type Message } from './index.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompiledContext {
  /**
   * 传给模型的系统规则、当前任务、已配对历史和允许使用的工具。
   *
   * EN: The system rules, current task, paired history, and allowed tools supplied to a model.
   */
  system: string;
  task: string;
  history: Message[];
  tools: ToolDefinition[];
  manifest: Record<string, unknown>;
  estimatedTokens: number;
}
/**
 * 在发起模型请求前拒绝无效或尚未结束的工具调用序列。
 *
 * EN: Rejects invalid or unfinished tool-call sequences before issuing a model request.
 */
export function validatePairs(messages: Message[]) {
  const sequence = inspectToolCalls(messages);
  if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
  if (sequence.pending.length) throw new AppError('TOOL_PAIR_INCOMPLETE', '工具调用结果缺失');
}
export class ProviderError extends AppError {
  /**
   * 一旦收到响应内容，调用方需要谨慎处理重试，避免把部分结果当成全新请求。
   *
   * EN: Once response content arrives, retries must be handled carefully rather than treating a partial outcome as a fresh request.
   */
  responseStarted = false;
  /**
   * 失败时已知的供应商用量；null 表示没有可用的用量信息。
   *
   * EN: Known provider usage on failure; null means no usable usage information is available.
   */
  usage: Usage | null = null;
  /** 根据 HTTP/网络状态给出初始重试建议；具体协议错误仍可在抛出前收紧 retryable。
   * EN: Derives the initial retry hint from HTTP/network status; protocol-specific failures may further restrict retryable before throwing.
   */
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
  /**
   * 接入层声明能力；compile 将共享上下文映射为具体协议，stream 逐步产出事件。
   *
   * EN: The adapter declares capabilities, compile maps shared context to a protocol, and stream yields events incrementally.
   */
  capabilities: { streaming: boolean; tools: boolean; nativeReplay: boolean };
  /**
   * 仅生成可序列化协议请求；凭据读取与网络副作用留到 stream。
   *
   * EN: Only builds a serializable protocol request; credential lookup and network side effects are deferred to stream.
   */
  compile(context: CompiledContext): Record<string, unknown>;
  /**
   * 通过 signal 响应取消，正常结束必须产出 completed，不能以 EOF 冒充完成。
   *
   * EN: Responds to cancellation through signal and must emit completed on normal finish; EOF alone cannot stand in for completion.
   */
  stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}
