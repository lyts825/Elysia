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

/** Concrete capability objects, never the gateway, kernel, database or client instances. */
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
export function capabilities<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Readonly<Pick<T, K>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, source[key]]))) as Readonly<Pick<T, K>>;
}
