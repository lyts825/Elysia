/**
 * 定义工具插件的调用、策略和注册契约。
 * EN: Define tool-plugin invocation, policy, and contribution contracts.
 *
 * 用类型约束工具定义、调用上下文与能力依赖，使工具发现、审核和执行使用相同元数据；本模块本身不执行工具。
 * EN: Type tool definitions, invocation context, and capabilities so discovery, review, and execution share metadata; this module does not execute tools.
 */
import { z } from 'zod';
import type { Task, Attempt, Operation } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { pluginServices } from './plugin-services.js';

/**
 * 只有网关可建立已授权调用并记录其结果。
 * EN: Only the gateway can create an authorized invocation and record its outcome.
 */
export interface ToolInvocation {
  /**
   * 网关已重读并校验为可执行状态的任务快照。
   * EN: A task snapshot reread and validated as executable by the gateway.
   */
  task: Task;
  /**
   * 本次工具调用所属的模型执行尝试。
   * EN: The model execution attempt owning this tool invocation.
   */
  attempt: Attempt;
  /**
   * 预先分配的操作身份；外部动作开始前由网关持久记录 INTENT。
   * EN: Preallocated operation identity; the gateway persists INTENT before external work starts.
   */
  operation: Operation;
  /**
   * 执行器取消信号，具体工具须传递给支持取消的 I/O。
   * EN: Executor cancellation signal, forwarded by concrete tools to cancellable I/O.
   */
  signal: AbortSignal;
}

export interface ToolPolicy {
  /**
   * 是否在存储事务内执行。
   * EN: Whether execution occurs inside the storage transaction.
   */
  transaction: boolean;
  /**
   * 是否与其他串行工具协调执行顺序。
   * EN: Whether invocation order must be coordinated with other serial tools.
   */
  serial: boolean;
  /**
   * 是否可能产生持久副作用。
   * EN: Whether this tool may cause persistent side effects.
   */
  mutating: boolean;
  /**
   * 成功调用是否计入运行时的进展判断。
   * EN: Whether successful invocation counts toward runtime progress detection.
   */
  progress: boolean;
}

export interface ToolContribution {
  readonly name: string;
  readonly policy: Readonly<ToolPolicy>;
  /**
   * 模型可见定义，调用者应获得可独立调整的副本。
   * EN: Return the model-visible definition as an independently adjustable copy.
   */
  definition(): ToolDefinition;
  /**
   * 将不可信 JSON 参数解析成该工具接受的输入；失败时不能执行。
   * EN: Parse untrusted JSON into accepted arguments; failed parsing must prevent execution.
   */
  parse(input: unknown): Record<string, unknown>;
  /**
   * 仅执行动作；操作账本和成功/失败事件由网关统一提交。
   * EN: Execute the action only; the gateway centrally commits operation state and success/failure
   * events.
   */
  execute(invocation: ToolInvocation, args: any): unknown;
}

/**
 * 网关提供能力对象，插件不获得网关实例本身。
 * EN: The gateway supplies capability objects; plugins do not receive the gateway instance itself.
 */
export type ToolServices = ReturnType<typeof pluginServices>;

/**
 * 将参数校验、模型可见定义、执行函数和策略封装为工具贡献。
 * 定义按需生成并返回独立副本，避免调用方修改共享缓存。
 * EN: Package validation, model-visible definition, execution, and policy as one tool contribution.
 * Build definitions lazily and return independent copies so callers cannot mutate the shared cache.
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
    /**
     * 惰性生成JSON Schema并缓存定义，每次返回独立副本。
     * EN: Generate and cache JSON Schema lazily, returning an independent definition copy each time.
     */
    definition() {
      definition ??= {
        name,
        description,
        parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
      };
      // 调用方可调整供应商专用请求，而不修改其他任务共用的工具目录。
      // EN: Callers can prepare provider-specific requests without mutating another task catalogue.
      return structuredClone(definition);
    },
    /**
     * 按注册schema解析不可信工具输入，失败时不执行工具。
     * EN: Parse untrusted tool input with the registered schema, preventing execution after validation failure.
     */
    parse: (input: unknown) => schema.parse(input),
    execute,
  });
}
