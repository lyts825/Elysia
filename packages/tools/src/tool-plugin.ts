import { z } from 'zod';
import type { Task, Attempt, Operation } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { ToolGateway } from './index.js';

/** Only the gateway can create an authorized invocation and record its outcome. */
export interface ToolInvocation {
  task: Task;
  attempt: Attempt;
  operation: Operation;
  signal: AbortSignal;
}

export interface ToolPolicy {
  transaction: boolean;
  serial: boolean;
  mutating: boolean;
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
export type ToolServices = Pick<
  ToolGateway,
  | 'store'
  | 'kernel'
  | 'path'
  | 'snapshot'
  | 'artifact'
  | 'diff'
  | 'submit'
  | 'fetch'
  | 'processes'
  | 'mcp'
  | 'definitions'
> & {
  catalogueBudget(task: Task): number;
};

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
