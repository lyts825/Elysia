/* 配置和校验工具评审及执行策略。 */
import './peer-review.css';
import { useId } from 'react';
import { CommandBackendPolicy, ToolReviewPolicy } from '../../../packages/contracts/src/execution-policy';
import type { SelectableProvider } from './ModelPicker';

export function executionPolicyIssue(
  review: ToolReviewPolicy | undefined,
  backend: CommandBackendPolicy | undefined,
  providers: SelectableProvider[],
) {
  if (!ToolReviewPolicy.safeParse(review ?? { mode: 'off' }).success) return '请选择完整的工具审核配置。';
  if (!CommandBackendPolicy.safeParse(backend ?? { kind: 'local' }).success)
    return '请输入有效的本地 Docker 镜像名称。';
  if (
    review?.mode === 'model' &&
    !providers.some(
      (p) => p.id === review.providerId && !p.archived && p.keyConfigured && p.checkedRevision === p.revision,
    )
  )
    return '请选择已验证的审核连接。';
  return '';
}
export function ExecutionPolicySetup({
  review,
  backend,
  providers,
  disabled,
  onReview,
  onBackend,
}: {
  review?: ToolReviewPolicy;
  backend?: CommandBackendPolicy;
  providers: SelectableProvider[];
  disabled: boolean;
  onReview: (value: ToolReviewPolicy) => void;
  onBackend: (value: CommandBackendPolicy) => void;
}) {
  const id = useId(),
    issue = executionPolicyIssue(review, backend, providers);
  return (
    <details className="peer-review-setup execution-policy-setup">
      <summary>工具审核与命令环境{issue ? ' · 配置待完善' : ''}</summary>
      <fieldset disabled={disabled} className="peer-review-models">
        <label htmlFor={id + '-review'}>执行前审核</label>
        <select
          id={id + '-review'}
          value={review?.mode ?? 'off'}
          onChange={(e) =>
            onReview(
              e.target.value === 'model'
                ? { mode: 'model', providerId: '' }
                : { mode: e.target.value as 'off' | 'rules' },
            )
          }
        >
          <option value="off">关闭额外审核</option>
          <option value="rules">规则审核</option>
          <option value="model">规则与模型审核</option>
        </select>
        <p className="field-help">
          审核写入、命令及 MCP
          操作，不扩大已有授权。模型审核使用本任务的请求与费用预算；审核失败时不执行该次调用。
        </p>
        {review?.mode === 'model' && (
          <label>
            审核连接
            <select
              value={review.providerId}
              onChange={(e) => onReview({ mode: 'model', providerId: e.target.value })}
            >
              <option value="">选择已验证连接</option>
              {providers
                .filter((p) => !p.archived && p.keyConfigured && p.checkedRevision === p.revision)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.model}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label htmlFor={id + '-backend'}>命令环境</label>
        <select
          id={id + '-backend'}
          value={backend?.kind ?? 'local'}
          onChange={(e) =>
            onBackend(e.target.value === 'docker' ? { kind: 'docker', image: '' } : { kind: 'local' })
          }
        >
          <option value="local">本机进程</option>
          <option value="docker">Docker 容器</option>
        </select>
        {backend?.kind === 'docker' ? (
          <>
            <label>
              本地已有镜像
              <input
                value={backend.image}
                placeholder="例如 python:3.13-slim"
                onChange={(e) => onBackend({ kind: 'docker', image: e.target.value })}
              />
            </label>
            <p className="field-help">
              仅隔离 exec
              命令：只挂载当前任务目录，禁用网络。授权整个任务目录写入时才可写；分路径写入限制下命令目录只读，文件工具仍按原授权工作。需已运行
              Docker 和预先安装镜像；失败不会改用本机执行。镜像需包含命令所需程序。MCP 与宿主的 Git
              管理不在此容器内。
            </p>
          </>
        ) : (
          <p className="field-help">
            本机命令具有当前用户的进程权限；工作目录和工具路径检查不等于操作系统隔离。
          </p>
        )}
        <p className="field-help">两项配置在创建后固定。规则审核是有限检查，不能代替权限与容器隔离。</p>
        {issue && <p role="alert">{issue}</p>}
      </fieldset>
    </details>
  );
}
