// 向工具插件提供受限服务及能力访问入口。
import { loadSkill, listSkills, loadSkillFile } from '../../context/src/skills.js';
import {
  listLocalMemories,
  readLocalMemory,
  scopedLocalItems,
  readLocalMcpConfig,
} from '../../context/src/local-library.js';
import { listProjectMemories, readProjectMemory } from '../../context/src/project-intelligence.js';
import { recallContext } from '../../context/src/index.js';
import { submitPeerReview } from '../../kernel/src/peer-review.js';
import type { ToolGateway } from './index.js';

/**
 * 构造冻结的能力对象，只暴露插件需要的绑定函数，不直接传递网关、内核或数据库实例。
 * catalogueBudget 根据任务计算目录大小预算，避免固定目录挤占模型上下文。
 */
export function pluginServices(
  gateway: ToolGateway,
  catalogueBudget: (task: Parameters<ToolGateway['definitions']>[0]) => number,
) {
  const store = gateway.store,
    kernel = gateway.kernel;
  return Object.freeze({
    store: Object.freeze({
      require: store.require.bind(store),
      put: store.put.bind(store),
      readObject: store.readObject.bind(store),
      directory: store.directory,
    }),
    kernel: Object.freeze({
      permissions: kernel.permissions.bind(kernel),
      ancestors: kernel.ancestors.bind(kernel),
      wait: kernel.wait.bind(kernel),
      event: kernel.event.bind(kernel),
      spawn: kernel.spawn.bind(kernel),
      allocateContext: kernel.allocateContext.bind(kernel),
      submitPeerReview: (
        task: Parameters<typeof submitPeerReview>[1],
        args: Parameters<typeof submitPeerReview>[2],
      ) => submitPeerReview(kernel, task, args),
    }),
    library: Object.freeze({
      listSkills: (scope: Parameters<typeof listSkills>[1]) => listSkills(store, scope),
      loadSkill: (id: string, scope: Parameters<typeof loadSkill>[2]) => loadSkill(id, store, scope),
      listLocalMemories: (...args: Tail<Parameters<typeof listLocalMemories>>) =>
        listLocalMemories(store, ...args),
      loadSkillFile: (...args: Tail<Parameters<typeof loadSkillFile>>) => loadSkillFile(store, ...args),
      readLocalMemory: (...args: Tail<Parameters<typeof readLocalMemory>>) => readLocalMemory(store, ...args),
      listProjectMemories: (...args: Tail<Parameters<typeof listProjectMemories>>) =>
        listProjectMemories(store, ...args),
      readProjectMemory: (...args: Tail<Parameters<typeof readProjectMemory>>) =>
        readProjectMemory(store, ...args),
      recallContext: (...args: Tail<Parameters<typeof recallContext>>) => recallContext(store, ...args),
      scopedLocalItems: (...args: Tail<Parameters<typeof scopedLocalItems>>) =>
        scopedLocalItems(store, ...args),
      readLocalMcpConfig: (...args: Tail<Parameters<typeof readLocalMcpConfig>>) =>
        readLocalMcpConfig(store, ...args),
    }),
    path: gateway.path.bind(gateway),
    snapshot: gateway.snapshot.bind(gateway),
    artifact: gateway.artifact.bind(gateway),
    diff: gateway.diff.bind(gateway),
    submit: gateway.submit.bind(gateway),
    fetch: gateway.fetch.bind(gateway),
    definitions: gateway.definitions.bind(gateway),
    runCommand: gateway.runCommand.bind(gateway),
    catalogueBudget,
    processes: Object.freeze({ run: gateway.processes.run.bind(gateway.processes) }),
    mcp: Object.freeze({
      inspect: gateway.mcp.inspect.bind(gateway.mcp),
      call: gateway.mcp.call.bind(gateway.mcp),
    }),
  });
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
/** 从能力对象中选择指定成员并冻结结果，避免插件获得未声明的能力。 */
export function capabilities<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Readonly<Pick<T, K>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, source[key]]))) as Readonly<Pick<T, K>>;
}
