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
        description:
          '仅供规划阶段总代理提出约定与下一版计划，提交后等待用户接受。保持当前合同版本、权限、预算、allowSameModelReview 及 peerReview；plan.contractVersion 匹配合同，version 为旧计划加一。可零子任务，已有 key 不复用；不能代替执行或用户确认。评审模式由内核自动创建评审代理，计划须为其预留名额，执行任务不能使用冻结的评审模型。',
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
