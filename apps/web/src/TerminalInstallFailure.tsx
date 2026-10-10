import type { TerminalCliInstallationJob } from '../../../packages/contracts/src/index';
import {
  terminalCliInstallFailure,
  type TerminalCliInstallRepair,
} from '../../../packages/contracts/src/cli-installation';

const actionLabels: Record<TerminalCliInstallRepair, string> = {
  check: '检查当前环境',
  version: '修改安装版本',
  template: '编辑镜像模板',
  retry: '定位重试入口',
};
export function TerminalInstallFailure({
  job,
  disabled,
  repair,
}: {
  job: TerminalCliInstallationJob;
  disabled?: boolean;
  repair?: (job: TerminalCliInstallationJob, action: TerminalCliInstallRepair) => void;
}) {
  if (job.status !== 'failed') return null;
  const failure = terminalCliInstallFailure(job.code, job.message);
  return (
    <div className="terminal-install-failure" data-failure={failure.code}>
      <small className="cli-app-error">
        <strong>{failure.category}</strong> · {failure.message}
      </small>
      {repair && (
        <div className="terminal-install-repairs">
          {failure.actions.map((action) => (
            <button
              type="button"
              key={action}
              className="text-button"
              disabled={disabled}
              onClick={() => repair(job, action)}
            >
              {actionLabels[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
