import type { NativeProjectDefaults } from '../../../packages/contracts/src/workflow';
import type { RunSetupDraft } from './RunSetupModal';
import { requirementLines } from './TaskRequirements';
import './run-setup.css';

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
  return (
    <section className="workflow-confirmation" aria-label="本次执行配置确认">
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
          <dd className="run-setup-reading" role="region" aria-label="本次模型完整配置" tabIndex={0}>
            {providerLabel} · {value.choice.model}
            {value.choice.reasoningEffort ? ` · ${value.choice.reasoningEffort}` : ''}
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
          <dd className="run-setup-reading" role="region" aria-label="本次权限完整范围" tabIndex={0}>
            项目内读取；
            {value.write
              ? `任务目录写入：${requirementLines(value.writePaths).join('、') || '未指定'}`
              : '不允许写入'}
            ；{value.exec ? '允许命令执行（当前系统用户权限）' : '不允许命令执行'}；
            {requirementLines(value.urls).length} 个授权网页
          </dd>
        </div>
        <div>
          <dt>预算上限</dt>
          <dd>
            {value.maxRequests} 次请求 · {value.maxTokens.toLocaleString()} Token
            {value.maxCost == null ? ' · 未设金额上限' : ` · 金额 ${value.maxCost}`}
          </dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>
            {value.contextPolicy.mode === 'managed'
              ? '托管'
              : `${value.contextPolicy.windowTokens?.toLocaleString() || '未指定'} Token`}
          </dd>
        </div>
      </dl>
      {(value.inputs || value.urls) && (
        <details>
          <summary>补充资料与网页范围</summary>
          <p
            className="workflow-prose run-setup-reading"
            role="region"
            aria-label="补充资料与网页完整范围"
            tabIndex={0}
          >
            {value.inputs || '未指定重点资料'}
            {value.urls && `\n授权网页：\n${value.urls}`}
          </p>
        </details>
      )}
      <p className="field-help">
        {differences.length ? `本次调整：${differences.join('、')}。` : '执行参数来自项目默认。'}
        权限仍由本次任务单独确认，点击底部按钮后才创建。
      </p>
      <button type="button" className="secondary" disabled={disabled} onClick={adjust}>
        调整配置
      </button>
    </section>
  );
}
