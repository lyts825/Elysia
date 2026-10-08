import { z } from 'zod';
import { Contract, Plan, invariant } from '../../../contracts/src/index.js';
import {
  PLAN_ALIGNMENT_MODULE,
  type PlanAlignmentFactory,
  type PlanAlignmentModule,
} from '../module-host.js';

const schema = z.object({ contract: Contract, plan: Plan });
const factory: PlanAlignmentFactory = {
  ...PLAN_ALIGNMENT_MODULE,
  apply(context) {
    let active = true;
    const checkActive = () => invariant(active, 'MODULE_DISPOSED', '计划对齐模块已释放');
    const module: PlanAlignmentModule = {
      ...PLAN_ALIGNMENT_MODULE,
      definition: {
        name: 'propose_plan',
        description: '总代理提出具体版本的约定和计划，等待接受。',
        parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
      },
      parse(input) {
        checkActive();
        return schema.parse(input);
      },
      propose(task, input) {
        checkActive();
        return context.propose(task, input.contract, input.plan);
      },
      accept(...args) {
        checkActive();
        return context.accept(...args);
      },
      dispose() {
        active = false;
      },
    };
    return module;
  },
};
export default factory;
