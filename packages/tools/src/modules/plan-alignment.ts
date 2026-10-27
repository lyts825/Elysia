/**
 * 提供计划提案模块，并在释放后拒绝继续使用。
 * EN: Provide the built-in plan proposal module and reject use after disposal.
 *
 * 把计划提案能力适配为工具模块，使用注入的服务而非自行创建应用状态；释放标记用于阻止失效实例继续工作。
 * EN: Adapt plan proposals into a tool module using injected services rather than creating app state, and reject work after disposal.
 */
import { z } from 'zod';
import { Contract, Plan, invariant } from '../../../contracts/src/index.js';
import {
  PLAN_ALIGNMENT_MODULE,
  type PlanAlignmentFactory,
  type PlanAlignmentModule,
} from '../module-host.js';

const schema = z.object({ contract: Contract, plan: Plan });
/**
 * 以固定插件身份暴露计划提案；释放后 parse、propose 和 accept 均拒绝调用。
 * EN: Expose plan proposal under a fixed plugin identity. After disposal, parse, propose, and accept
 * all reject calls.
 */
const factory: PlanAlignmentFactory = {
  ...PLAN_ALIGNMENT_MODULE,
  /**
   * 为一个宿主创建独立active状态及固定工具定义，依赖仅来自传入计划上下文。
   * EN: Create host-local active state and a fixed tool definition using only the injected plan context.
   */
  apply(context) {
    let active = true;
    /**
     * 所有公开动作先检查active，释放后不得继续校验或修改计划。
     * EN: Guard public actions with active state so disposed instances cannot parse or change plans.
     */
    const checkActive = () => invariant(active, 'MODULE_DISPOSED', '计划对齐模块已释放');
    const module: PlanAlignmentModule = {
      ...PLAN_ALIGNMENT_MODULE,
      definition: {
        name: 'propose_plan',
        description:
          '仅供规划阶段总代理提出约定与下一版计划，提交后等待用户接受。保持当前合同版本、权限、预算、allowSameModelReview、peerReview、toolReview 及 commandBackend；plan.contractVersion 匹配合同，version 为旧计划加一。可零子任务，已有 key 不复用；不能代替执行或用户确认。评审模式由内核自动创建评审代理，计划须为其预留名额，执行任务不能使用冻结的评审模型。',
        parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
      },
      /**
       * 先检查生命周期，再按合同/计划schema解析输入；领域约束仍由内核处理。
       * EN: Check lifecycle before parsing contract/plan schemas; the kernel still enforces domain constraints.
       */
      parse(input) {
        checkActive();
        return schema.parse(input);
      },
      /**
       * 把已解析合同与计划提交到原内核提案入口，不自动接受。
       * EN: Forward the parsed contract and plan to the original kernel proposal entry without accepting it.
       */
      propose(task, input) {
        checkActive();
        return context.propose(task, input.contract, input.plan);
      },
      /**
       * 在实例仍有效时转发接受操作，保持原内核的版本和权限门禁。
       * EN: Forward acceptance only while active, retaining original kernel revision and permission gates.
       */
      accept(...args) {
        checkActive();
        return context.accept(...args);
      },
      /**
       * 置active为false使后续动作失败，重复释放无需额外副作用。
       * EN: Set active=false to reject future actions; repeated disposal requires no additional side effect.
       */
      dispose() {
        active = false;
      },
    };
    return module;
  },
};
export default factory;
