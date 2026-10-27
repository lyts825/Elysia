/** 将终端服务适配为运行时执行插件。 */
import type { Run } from '../../contracts/src/index.js';
import type { DockerAgentService } from './docker-agent.js';
import type { ExecutionPlugin } from './execution-plugins.js';

/** All terminal-specific capacity and lifetime rules live beside the terminal implementation. */
/** 将 Docker 终端接入执行器，委托步骤、中断、释放及资源准入。 */
export function terminalExecutionPlugin(terminal: DockerAgentService): ExecutionPlugin {
  const preset = (run: Run) =>
    run.execution?.kind === 'docker-agent' ? run.execution.profile.resourcePreset : undefined;
  return {
    manifest: { id: 'execution.terminal', version: '1.0.0', apiVersion: 1 },
    contributions: {
      'docker-agent': {
        step: (task, signal) => terminal.run(task, signal),
        interrupt: (runId, taskId) => terminal.interrupt(runId, taskId),
        dispose: () => terminal.dispose(),
        queueMetadata: (run) => ({ resourcePreset: preset(run) ?? 'standard' }),
        admission: {
          // 准备仅刷新容量，不启动 CLI；预约与队列原因都按任务创建时冻结的资源规格计算。
          prepare: (signal) => terminal.refreshResourceCapacity(signal),
          unavailable: (run) => {
            const reason = terminal.resources.reason(preset(run));
            return reason === 'terminal-resources' ? undefined : reason;
          },
          reason: (task, run) =>
            terminal.resources.canAcquireTask(task.id, preset(run))
              ? undefined
              : terminal.resources.reason(preset(run)),
          acquire: (task, run) => terminal.resources.tryAcquire(task.id, 'task', preset(run)),
          release: (taskId) => terminal.resources.release(taskId),
        },
      },
    },
  };
}
