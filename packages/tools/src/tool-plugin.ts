// 定义工具插件的调用、策略和注册契约。
import { z } from 'zod';
import type { Task, Attempt, Operation } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { pluginServices } from './plugin-services.js';

/** Only the gateway can create an authorized invocation and record its outcome. */
export interface ToolInvocation {
  task: Task;
  attempt: Attempt;
  operation: Operation;
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
  definition(): ToolDefinition;
  parse(input: unknown): Record<string, unknown>;
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
