import type { NativeProjectDefaults } from '../../../packages/contracts/src/workflow';
import type { RunSetupDraft } from './RunSetupModal';
import { requirementLines } from './TaskRequirements';
import './run-setup.css';
import './run-confirmation.css';

export function RunConfirmation({
  projectName,
  objective,
  value,
  defaults,
  providerLabel,
  adjust,
  disabled,
}: {
  projectName?: string;
  objective: string;
  value: RunSetupDraft;
  defaults: NativeProjectDefaults;
  providerLabel?: string;
  adjust: () => void;
  disabled: boolean;
}) {
  const differences = [
    JSON.stringify(value.choice) !== JSON.stringify(defaults.modelChoice) && '模型',
    value.planMode !== defaults.planMode && '计划模式',
    JSON.stringify(value.contextPolicy) !== JSON.stringify(defaults.contextPolicy) && '上下文',
    (value.maxRequests !== defaults.budget.maxRequests ||
      value.maxTokens !== defaults.budget.maxTokens ||
      value.maxCost !== defaults.budget.maxCost) &&
      '预算',
    value.concurrency !== defaults.concurrency && '并发',
  ].filter(Boolean);
  const authorizedUrls = requirementLines(value.urls);
  const writePaths = requirementLines(value.writePaths);
  return (
    <section className="workflow-confirmation run-review-confirmation" aria-label="本次执行配置确认">
      <h3>确认本次执行</h3>
      <dl className="run-confirmation-grid">
        <div className="run-confirmation-wide">
          <dt>项目与目标</dt>
          <dd>
            {projectName && (
              <p className="run-setup-reading" role="region" aria-label="所属项目完整名称" tabIndex={0}>
                {projectName}
              </p>
            )}
            <p
              className="workflow-prose run-setup-reading"
              role="region"
              aria-label="本次执行目标"
              tabIndex={0}
            >
              {objective}
            </p>
          </dd>
        </div>
        <div className="run-confirmation-wide">
          <dt>模型</dt>
          <dd>
            <dl
              className="run-review-fields run-setup-reading"
              role="region"
              aria-label="本次模型完整配置"
              tabIndex={0}
            >
              <div>
                <dt>连接名称</dt>
                <dd>{providerLabel || '未提供连接名称'}</dd>
              </div>
              <div>
                <dt>模型标识</dt>
                <dd>{value.choice.model || '未指定'}</dd>
              </div>
              <div>
                <dt>思考强度</dt>
                <dd>{value.choice.reasoningEffort || '未指定'}</dd>
              </div>
              <div>
                <dt>连接标识</dt>
                <dd>{value.choice.providerId || '未指定'}</dd>
              </div>
            </dl>
          </dd>
        </div>
        <div>
          <dt>执行方式</dt>
          <dd>
            {value.planMode ? '先生成计划，接受后执行' : '创建后直接执行'} · {value.concurrency} 个并发实例
          </dd>
        </div>
        <div>
          <dt>审计模型</dt>
          <dd>{value.allowSameModelReview ? '已确认允许与执行模型相同' : '必须与执行模型不同'}</dd>
        </div>
        <div className="run-confirmation-wide">
          <dt>权限范围</dt>
          <dd>
            <dl
              className="run-review-fields run-setup-reading"
              role="region"
              aria-label="本次权限配置"
              tabIndex={0}
            >
              <div>
                <dt>读取</dt>
                <dd>项目内读取</dd>
              </div>
              <div>
                <dt>写入</dt>
                <dd>{value.write ? `允许任务目录写入 · ${writePaths.length} 项范围` : '不允许写入'}</dd>
              </div>
              <div>
                <dt>命令执行</dt>
                <dd>{value.exec ? '允许（当前系统用户权限）' : '不允许命令执行'}</dd>
              </div>
              <div>
                <dt>网页授权</dt>
                <dd>
                  {authorizedUrls.length
                    ? `${authorizedUrls.length} 个网页，完整范围见下方授权网页`
                    : '0 个网页 · 未授权网页'}
                </dd>
              </div>
            </dl>
          </dd>
        </div>
        <div>
          <dt>预算上限</dt>
          <dd>
            <span>{value.maxRequests} 次请求</span>
            <span>{value.maxTokens.toLocaleString()} Token</span>
            <span>{value.maxCost == null ? '未设金额上限' : `金额上限 ${value.maxCost}`}</span>
          </dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>
            {value.contextPolicy.mode === 'managed'
              ? '托管'
              : `手动 · ${value.contextPolicy.windowTokens?.toLocaleString() || '未指定'} Token`}
          </dd>
        </div>
      </dl>
      {value.write && (
        <details className="run-review-materials run-review-write-paths">
          <summary>写入范围 · {writePaths.length} 项</summary>
          <p
            className="workflow-prose run-setup-reading"
            role="region"
            aria-label="本次完整写入范围"
            tabIndex={0}
          >
            {writePaths.join('\n') || '未指定'}
          </p>
        </details>
      )}
      {value.inputs.trim() && (
        <details className="run-review-materials">
          <summary>重点资料 · 已填写</summary>
          <p
            className="workflow-prose run-setup-reading"
            role="region"
            aria-label="本次重点资料完整内容"
            tabIndex={0}
          >
            {value.inputs}
          </p>
        </details>
      )}
      <details className="run-review-materials">
        <summary>授权网页 · {authorizedUrls.length} 项</summary>
        <p
          className="workflow-prose run-setup-reading"
          role="region"
          aria-label="本次授权网页完整范围"
          tabIndex={0}
        >
          {authorizedUrls.length ? value.urls : '未授权网页'}
        </p>
      </details>
      <p className="field-help run-review-defaults">
        {differences.length
          ? `与项目默认相比，本次调整：${differences.join('、')}。`
          : '模型、计划模式、上下文、预算与并发沿用项目默认。'}
        权限仍由本次任务单独确认，点击底部按钮后才创建。
      </p>
      <button type="button" className="secondary" disabled={disabled} onClick={adjust}>
        调整配置
      </button>
    </section>
  );
}
