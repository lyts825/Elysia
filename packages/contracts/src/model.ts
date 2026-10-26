import { AppError, inspectToolCalls, type ToolCall, type Usage, type Message } from './index.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompiledContext {
  system: string;
  task: string;
  history: Message[];
  tools: ToolDefinition[];
  manifest: Record<string, unknown>;
  estimatedTokens: number;
}
export function validatePairs(messages: Message[]) {
  const sequence = inspectToolCalls(messages);
  if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
  if (sequence.pending.length) throw new AppError('TOOL_PAIR_INCOMPLETE', '工具调用结果缺失');
}
export class ProviderError extends AppError {
  responseStarted = false;
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
  capabilities: { streaming: boolean; tools: boolean; nativeReplay: boolean };
  compile(context: CompiledContext): Record<string, unknown>;
  stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}
