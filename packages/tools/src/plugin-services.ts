/**
 * 向工具插件提供受限服务及能力访问入口。
 * EN: Provide restricted service and capability objects to tool plugins.
 *
 * 将应用能力拆成插件需要的服务集合，使插件通过注入访问存储、命令或资源；避免让每个插件依赖完整宿主实现。
 * EN: Split app capabilities into injected service sets for storage, commands, and resources, avoiding a dependency on the entire host implementation.
 */
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
 * EN: Build frozen capability objects exposing only required bound functions, not gateway, kernel,
 * or database instances. catalogueBudget derives a task-specific catalogue allowance instead of
 * crowding out model context with fixed lists.
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
      /**
       * 绑定当前内核的独立评审提交服务，不向插件公开整个内核。
       * EN: Bind peer-review submission to this kernel without exposing the kernel instance.
       */
      submitPeerReview: (
        task: Parameters<typeof submitPeerReview>[1],
        args: Parameters<typeof submitPeerReview>[2],
      ) => submitPeerReview(kernel, task, args),
    }),
    library: Object.freeze({
      /**
       * 按运行范围列出技能元数据，具体冻结与可见性规则由资源库执行。
       * EN: List run-scoped skill metadata, leaving frozen-content and visibility rules to the resource library.
       */
      listSkills: (scope: Parameters<typeof listSkills>[1]) => listSkills(store, scope),
      /**
       * 绑定当前Store读取指定技能正文，不在此扩大任务能力。
       * EN: Load a specified skill through this Store without expanding task capabilities.
       */
      loadSkill: (id: string, scope: Parameters<typeof loadSkill>[2]) => loadSkill(id, store, scope),
      /**
       * 转发本机记忆目录读取并隐式绑定Store，插件只传业务参数。
       * EN: Forward local-memory catalogue reads with Store bound, exposing business arguments only.
       */
      listLocalMemories: (...args: Tail<Parameters<typeof listLocalMemories>>) =>
        listLocalMemories(store, ...args),
      /**
       * 绑定Store分页读取技能参考文件，资源库继续核验路径与冻结范围。
       * EN: Read paged skill references through the bound Store, retaining library path/frozen-scope checks.
       */
      loadSkillFile: (...args: Tail<Parameters<typeof loadSkillFile>>) => loadSkillFile(store, ...args),
      /**
       * 转发单条本机记忆读取，生效与撤销规则保留在资源库。
       * EN: Forward one local-memory read while preserving library enablement/revocation rules.
       */
      readLocalMemory: (...args: Tail<Parameters<typeof readLocalMemory>>) => readLocalMemory(store, ...args),
      /**
       * 通过当前Store取得项目记忆目录，调用参数必须包含项目范围。
       * EN: Read project-memory metadata through this Store with explicit project scope.
       */
      listProjectMemories: (...args: Tail<Parameters<typeof listProjectMemories>>) =>
        listProjectMemories(store, ...args),
      /**
       * 通过资源库读取项目记忆正文及来源版本，不提供数据库连接。
       * EN: Read project-memory body and provenance through the library without exposing the database connection.
       */
      readProjectMemory: (...args: Tail<Parameters<typeof readProjectMemory>>) =>
        readProjectMemory(store, ...args),
      /**
       * 回查保留上下文的原文引用，仍由上下文模块核验任务归属。
       * EN: Recall retained-context originals while the context module checks task ownership.
       */
      recallContext: (...args: Tail<Parameters<typeof recallContext>>) => recallContext(store, ...args),
      /**
       * 按运行能力快照选取本机资料，返回范围内条目。
       * EN: Select local resources according to the run capability snapshot and return scoped entries.
       */
      scopedLocalItems: (...args: Tail<Parameters<typeof scopedLocalItems>>) =>
        scopedLocalItems(store, ...args),
      /**
       * 读取范围内MCP连接配置，凭据环境引用到连接时才解析。
       * EN: Read a scoped MCP configuration; credential environment references are resolved only at connection time.
       */
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
    backgroundJobs: Object.freeze({
      start: gateway.backgroundJobs.start.bind(gateway.backgroundJobs),
      read: gateway.backgroundJobs.read.bind(gateway.backgroundJobs),
      cancel: gateway.backgroundJobs.cancel.bind(gateway.backgroundJobs),
    }),
    catalogueBudget,
    processes: Object.freeze({ run: gateway.processes.run.bind(gateway.processes) }),
    mcp: Object.freeze({
      inspect: gateway.mcp.inspect.bind(gateway.mcp),
      call: gateway.mcp.call.bind(gateway.mcp),
    }),
  });
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
/**
 * 从能力对象中选择指定成员并冻结结果，避免插件获得未声明的能力。
 * EN: Select explicit capability members and freeze the result so plugins do not obtain undeclared
 * capabilities.
 */
export function capabilities<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Readonly<Pick<T, K>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, source[key]]))) as Readonly<Pick<T, K>>;
}
