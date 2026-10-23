import { useId } from 'react';
import type { TerminalCliInstallationJob } from '../../../packages/contracts/src/index';
import {
  terminalCliInstallFailure,
  type TerminalCliInstallRepair,
} from '../../../packages/contracts/src/cli-installation';
import './terminal-operation-notices.css';

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
  const titleId = useId();
  if (job.status !== 'failed') return null;
  const failure = terminalCliInstallFailure(job.code, job.message);
  return (
    <div className="terminal-install-failure" data-failure={failure.code}>
      <header className="terminal-operation-heading">
        <strong className="terminal-install-failure-title" id={titleId}>
          {failure.category}
        </strong>
        <span>安装未完成</span>
      </header>
      <p>{failure.message}</p>
      <details className="terminal-install-failure-details">
        <summary>查看失败记录</summary>
        <dl
          className="terminal-operation-reading"
          tabIndex={0}
          role="region"
          aria-label="终端安装失败完整记录"
        >
          <div>
            <dt>错误代码</dt>
            <dd>
              <code>{failure.code}</code>
            </dd>
          </div>
          {job.requestedVersion && (
            <div>
              <dt>请求版本</dt>
              <dd>{job.requestedVersion}</dd>
            </div>
          )}
          {job.message && (
            <div>
              <dt>原始说明</dt>
              <dd>{job.message}</dd>
            </div>
          )}
        </dl>
      </details>
      {repair && (
        <div className="terminal-install-repairs">
          {failure.actions.map((action) => (
            <button
              type="button"
              key={action}
              className="secondary"
              disabled={disabled}
              aria-describedby={titleId}
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
