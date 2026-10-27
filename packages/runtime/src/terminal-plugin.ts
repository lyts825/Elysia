/**
 * 将终端服务适配为运行时执行插件。
 * 仅把准备、单步、停止和资源视图适配为通道接口，任务状态、凭据和容器生命周期仍由终端服务负责。
 * EN: Adapts terminal services into a runtime execution plugin. Adapts preparation/steps/interruption/resource views to channel interfaces while terminal service retains state/credential/container ownership.
 */
import type { Run } from '../../contracts/src/index.js';
import type { DockerAgentService } from './docker-agent.js';
import type { ExecutionPlugin } from './execution-plugins.js';

/**
 * 终端特有的容量与生命周期规则与终端实现放在一起维护。 将 Docker 终端接入执行器，委托步骤、中断、释放及资源准入。
 * EN: All terminal-specific capacity and lifetime rules live beside the terminal implementation. Connects Docker terminals to the executor by delegating steps, interruption, disposal, and resource admission.
 */
export function terminalExecutionPlugin(terminal: DockerAgentService): ExecutionPlugin {
  /**
   * 仅从运行创建时冻结的终端配置读取资源规格，非终端运行返回undefined。
   * EN: Reads resource requirements only from the run's frozen terminal profile; non-terminal runs return undefined.
   */
  const preset = (run: Run) =>
    run.execution?.kind === 'docker-agent' ? run.execution.profile.resourcePreset : undefined;
  return {
    manifest: { id: 'execution.terminal', version: '1.0.0', apiVersion: 1 },
    contributions: {
      'docker-agent': {
        /**
         * 在宿主已准入后执行一轮Docker终端，不在适配层重新安排其他任务。
         * EN: Runs one Docker-terminal turn after host admission without scheduling other work in this adapter.
         */
        step: (task, signal) => terminal.run(task, signal),
        /**
         * 把运行和可选任务范围交给终端服务，等待容器停止及资源归属核验。
         * EN: Delegates run and optional task scope to the terminal service and waits for stopping and resource-ownership verification.
         */
        interrupt: (runId, taskId) => terminal.interrupt(runId, taskId),
        /**
         * 关闭终端服务并等待探测及活动容器的清理流程。
         * EN: Closes terminal services and awaits cleanup of probes and active containers.
         */
        dispose: () => terminal.dispose(),
        /**
         * 把冻结资源规格附到队列快照，缺省值使用标准规格，仅用于展示。
         * EN: Adds the frozen resource preset to queue snapshots, defaulting to standard for display.
         */
        queueMetadata: (run) => ({ resourcePreset: preset(run) ?? 'standard' }),
        admission: {
          /**
           * 准备仅刷新容量，不启动 CLI；预约与队列原因都按任务创建时冻结的资源规格计算。
           * EN: Preparation only refreshes capacity and never starts a CLI. Reservations and queue reasons use the task's frozen resource requirements.
           */
          prepare: (signal) => terminal.refreshResourceCapacity(signal),
          /**
           * 只把引擎和总容量问题作为运行级不可用原因，暂时资源占用交给任务级排队。
           * EN: Reports engine and total-capacity problems at run level while leaving temporary occupation to task-level queuing.
           */
          unavailable: (run) => {
            const reason = terminal.resources.reason(preset(run));
            return reason === 'terminal-resources' ? undefined : reason;
          },
          /**
           * 队列解释复用真实预约资格；已有预约可继续，不能用不同规则误报可执行。
           * EN: Uses actual reservation eligibility for queue explanations; existing reservations remain eligible under the same rules.
           */
          reason: (task, run) =>
            terminal.resources.canAcquireTask(task.id, preset(run))
              ? undefined
              : terminal.resources.reason(preset(run)),
          /**
           * 按任务ID和冻结规格同步尝试预约，结果false时宿主不能派发该任务。
           * EN: Synchronously attempts reservation by task ID and frozen preset; false prevents host dispatch.
           */
          acquire: (task, run) => terminal.resources.tryAcquire(task.id, 'task', preset(run)),
          /**
           * 步骤结束后请求释放预约；被hold保护的未确认资源由资源池保守保留。
           * EN: Requests release after a step; held resources remain conservatively retained by the pool.
           */
          release: (taskId) => terminal.resources.release(taskId),
        },
      },
    },
  };
}
