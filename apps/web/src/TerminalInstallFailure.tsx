/* 展示终端安装失败信息及修复指引。 */
import { useId } from 'react';
import type { TerminalCliInstallationJob } from '../../../packages/contracts/src/index';
import {
  terminalCliInstallFailure,
  type TerminalCliInstallRepair,
} from '../../../packages/contracts/src/cli-installation';
import './terminal-operation-notices.css';
import './terminal-install-failure.css';

const actionLabels: Record<TerminalCliInstallRepair, string> = {
  check: '检查当前环境',
  version: '修改安装版本',
  template: '编辑镜像模板',
  retry: '定位重试入口',
};
/** 只为失败的安装任务显示诊断和修复操作；repair 负责导航，不自动重试安装。 */
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
  const repairHelpId = useId();
  if (job.status !== 'failed') return null;
  // 根据失败代码和消息生成修复类别；未失败的任务不显示此面板。
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
      <dl className="terminal-install-failure-target" aria-label="本次失败的安装目标">
        <div>
          <dt>终端应用</dt>
          <dd>{job.appId === 'custom' ? '自定义 CLI' : job.appId}</dd>
        </div>
        <div>
          <dt>请求版本</dt>
          <dd>{job.requestedVersion || '未指定'}</dd>
        </div>
      </dl>
      <details className="terminal-install-failure-details">
        <summary>查看失败记录</summary>
        <dl
          className="terminal-operation-reading"
          tabIndex={0}
          role="region"
          aria-label="终端安装失败完整记录"
        >
          <div>
            <dt>安装记录</dt>
            <dd>
              <code>{job.id}</code> · v{job.revision}
            </dd>
          </div>
          <div>
            <dt>基础镜像</dt>
            <dd>{job.baseImage}</dd>
          </div>
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
        <section className="terminal-install-repair-section" aria-label="处理安装问题">
          <p className="field-help" id={repairHelpId}>
            下列入口用于检查环境或定位安装配置；重新安装仍需在对应入口明确发起。
          </p>
          <div className="terminal-install-repairs">
            {failure.actions.map((action) => (
              <button
                type="button"
                key={action}
                className="secondary"
                disabled={disabled}
                aria-describedby={`${titleId} ${repairHelpId}`}
                onClick={() => repair(job, action)}
              >
                {actionLabels[action]}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
