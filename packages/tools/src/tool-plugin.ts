// 定义工具插件的调用、策略和注册契约。
import { z } from 'zod';
import type { Task, Attempt, Operation } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { pluginServices } from './plugin-services.js';

/** Only the gateway can create an authorized invocation and record its outcome. */
export interface ToolInvocation {
  /** 网关已重读并校验为可执行状态的任务快照。 */
  task: Task;
  /** 本次工具调用所属的模型执行尝试。 */
  attempt: Attempt;
  /** 预先分配的操作身份；外部动作开始前由网关持久记录 INTENT。 */
  operation: Operation;
  /** 执行器取消信号，具体工具须传递给支持取消的 I/O。 */
  signal: AbortSignal;
}

export interface ToolPolicy {
  /** 是否在存储事务内执行。 */
  transaction: boolean;
  /** 是否与其他串行工具协调执行顺序。 */
  serial: boolean;
  /** 是否可能产生持久副作用。 */
  mutating: boolean;
  /** 成功调用是否计入运行时的进展判断。 */
  progress: boolean;
}

export interface ToolContribution {
  readonly name: string;
  readonly policy: Readonly<ToolPolicy>;
  /** 模型可见定义，调用者应获得可独立调整的副本。 */
  definition(): ToolDefinition;
  /** 将不可信 JSON 参数解析成该工具接受的输入；失败时不能执行。 */
  parse(input: unknown): Record<string, unknown>;
  /** 仅执行动作；操作账本和成功/失败事件由网关统一提交。 */
  execute(invocation: ToolInvocation, args: any): unknown;
}

/** Capabilities are supplied by the gateway; plugins do not receive the gateway itself. */
export type ToolServices = ReturnType<typeof pluginServices>;

/**
 * 将参数校验、模型可见定义、执行函数和策略封装为工具贡献。
 * 定义按需生成并返回独立副本，避免调用方修改共享缓存。
 */
export function defineTool<Schema extends z.ZodType<Record<string, unknown>>>(
  name: string,
  schema: Schema,
  description: string,
  policy: ToolPolicy,
  execute: (invocation: ToolInvocation, args: z.output<Schema>) => unknown,
): ToolContribution {
  let definition: ToolDefinition | undefined;
  return Object.freeze({
    name,
    policy: Object.freeze({ ...policy }),
    definition() {
      definition ??= {
        name,
        description,
        parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
      };
      // Callers may prepare provider-specific requests without mutating another task's catalogue.
      return structuredClone(definition);
    },
    parse: (input: unknown) => schema.parse(input),
    execute,
  });
}
