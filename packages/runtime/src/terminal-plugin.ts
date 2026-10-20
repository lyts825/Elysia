import type { Run } from '../../contracts/src/index.js';
import type { DockerAgentService } from './docker-agent.js';
import type { ExecutionPlugin } from './execution-plugins.js';

/** All terminal-specific capacity and lifetime rules live beside the terminal implementation. */
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
