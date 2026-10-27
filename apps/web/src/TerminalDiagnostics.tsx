/* 展示终端诊断及修复选项。 */
import { useEffect, useRef, useState } from 'react';
import type { TerminalProfileDiagnostics } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './terminal-diagnostics.css';

type Readiness = {
  available: boolean;
  message: string;
  code?: string;
  stages?: Record<string, { status: string; message: string; code?: string }>;
};
export type TerminalDiagnosticRepair = {
  kind: 'connection' | 'template' | 'install' | 'project';
  profileId: string;
  appId: TerminalProfileDiagnostics['appId'];
  connectionId?: string;
  projectId?: string;
};
const sourceLabels = { template: '模板指定', project: '项目指定', app: '应用默认', environment: '环境变量' };
const stageLabels: Record<string, string> = {
  engine: 'Docker',
  image: '镜像',
  cli: 'CLI',
  configuration: '配置',
  authentication: 'API 认证',
};
/**
 * 按模板及可选项目检查配置来源与本地运行环境，并将修复目标交给上层导航。
 * 配置变化时取消旧检查，外部 recheckRequest 可触发一次重新检查。
 */
export function TerminalDiagnostics({
  profileId,
  projectId,
  configKey,
  disabled,
  repair,
  recheckRequest,
  rechecked,
}: {
  profileId: string;
  projectId?: string;
  configKey: string;
  disabled?: boolean;
  repair?: (target: TerminalDiagnosticRepair) => void;
  recheckRequest?: number;
  rechecked?: () => void;
}) {
  const { api } = useSurfaceClient();
  const [result, setResult] = useState<{
    configuration: TerminalProfileDiagnostics;
    readiness: Readiness;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const checkedRequest = useRef(0);
  // 模板、项目或配置指纹改变后旧诊断不再适用，取消请求并清空其结果。
  useEffect(() => {
    controller.current?.abort();
    setResult(null);
    setError('');
    setBusy(false);
    return () => controller.current?.abort();
  }, [configKey, profileId, projectId]);
  // 外层修复完成可递增请求号；每个请求号只消费一次，忙碌时等待当前检查结束。
  useEffect(() => {
    if (!recheckRequest || checkedRequest.current === recheckRequest || disabled || busy) return;
    checkedRequest.current = recheckRequest;
    void check().finally(() => rechecked?.());
  }, [recheckRequest, disabled, busy]);
  /** 先读取配置诊断，再检查运行环境；环境检查失败仍展示已取得的配置诊断。 */
  async function check() {
    if (disabled || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const configuration = await api<TerminalProfileDiagnostics>(
        `/terminal/control/profiles/${profileId}/diagnostics`,
        projectId ? { projectId } : {},
        undefined,
        request.signal,
      );
      let readiness: Readiness;
      try {
        readiness = await api<Readiness>(
          '/terminal/check',
          { profileId, ...(projectId ? { projectId } : {}) },
          undefined,
          request.signal,
        );
      } catch (issue) {
        if (request.signal.aborted) return;
        const message = issue instanceof Error ? issue.message : '本地运行环境检查未完成';
        readiness = {
          available: false,
          message,
          ...(issue instanceof ApiError ? { code: issue.code } : {}),
          stages: { configuration: { status: 'failed', message } },
        };
      }
      if (!request.signal.aborted) setResult({ configuration, readiness });
    } catch (issue) {
      if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '就绪检查未完成');
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  /** 把诊断结果中的实际应用和连接身份传给外层导航，不直接执行修复或修改配置。 */
  function target(kind: TerminalDiagnosticRepair['kind']) {
    const configuration = result!.configuration;
    repair?.({
      kind,
      profileId,
      appId: configuration.appId,
      ...(configuration.connection ? { connectionId: configuration.connection.id } : {}),
      ...(projectId ? { projectId } : {}),
    });
  }
  /** 将已知配置问题映射到对应修复入口，其他问题回到模板设置。 */
  function issueKind(code: string): TerminalDiagnosticRepair['kind'] {
    if (code === 'TERMINAL_PROJECT_CONNECTION_FALLBACK') return 'project';
    if (['API_KEY_MISSING', 'TERMINAL_CREDENTIAL_MISSING'].includes(code) && result?.configuration.connection)
      return 'connection';
    return 'template';
  }
  const labels = {
    connection: '编辑连接',
    template: '编辑模板',
    install: '安装或切换镜像',
    project: '编辑项目默认',
  };
  return (
    <div className="terminal-diagnosis-panel">
      <p className="terminal-diagnosis-scope">
        按当前模板{projectId ? '与项目配置' : ''}读取配置来源，并检查本地运行环境。
      </p>
      <button type="button" className="secondary" disabled={disabled || busy} onClick={() => void check()}>
        {busy ? '检查中…' : '检查就绪'}
      </button>
      {error && (
        <p className="terminal-diagnosis-error" role="alert" aria-label="就绪检查失败详情" tabIndex={0}>
          {error}
        </p>
      )}
      {result && (
        <details className="terminal-diagnosis-result" open>
          <summary>
            {result.configuration.ready && result.readiness.available ? '本地运行环境已就绪' : '就绪检查结果'}
          </summary>
          <p className="terminal-diagnosis-overview" role="status">
            {busy
              ? '正在重新检查，以下保留上次结果。'
              : error
                ? '重新检查失败，以下保留上次结果。'
                : `${result.readiness.stages ? `已返回 ${Object.keys(result.readiness.stages).length} 项阶段结果` : '未提供分阶段结果'} · ${result.configuration.issues.length} 项配置问题或提示`}
          </p>
          <dl className="terminal-diagnosis-context">
            <div>
              <dt>模板</dt>
              <dd
                className="terminal-diagnosis-reading"
                role="region"
                aria-label="诊断模板完整名称"
                tabIndex={0}
              >
                {result.configuration.profileLabel}
              </dd>
            </div>
            <div>
              <dt>配置来源</dt>
              <dd>{sourceLabels[result.configuration.source]}</dd>
            </div>
            {result.configuration.connection && (
              <div>
                <dt>连接</dt>
                <dd
                  className="terminal-diagnosis-reading"
                  role="region"
                  aria-label="诊断连接完整名称"
                  tabIndex={0}
                >
                  {result.configuration.connection.name}
                </dd>
              </div>
            )}
            {result.configuration.connection && (
              <div>
                <dt>型号</dt>
                <dd
                  className="terminal-diagnosis-reading"
                  role="region"
                  aria-label="诊断完整型号"
                  tabIndex={0}
                >
                  {result.configuration.connection.model}
                </dd>
              </div>
            )}
          </dl>
          <details className="terminal-diagnosis-source">
            <summary>已读来源与版本</summary>
            <dl
              className="terminal-diagnosis-context terminal-diagnosis-reading"
              role="region"
              aria-label="诊断完整来源与版本"
              tabIndex={0}
            >
              <div>
                <dt>模板标识</dt>
                <dd>{result.configuration.profileId}</dd>
              </div>
              <div>
                <dt>应用</dt>
                <dd>{result.configuration.appId}</dd>
              </div>
              <div>
                <dt>镜像</dt>
                <dd>{result.configuration.image}</dd>
              </div>
              <div>
                <dt>模板配置版本</dt>
                <dd>{result.configuration.settingsRevision}</dd>
              </div>
              <div>
                <dt>应用配置版本</dt>
                <dd>{result.configuration.appsRevision}</dd>
              </div>
              {result.configuration.projectId && (
                <>
                  <div>
                    <dt>项目标识</dt>
                    <dd>{result.configuration.projectId}</dd>
                  </div>
                  <div>
                    <dt>项目配置版本</dt>
                    <dd>{result.configuration.projectRevision ?? '未记录'}</dd>
                  </div>
                </>
              )}
              {result.configuration.connection && (
                <>
                  <div>
                    <dt>连接标识</dt>
                    <dd>{result.configuration.connection.id}</dd>
                  </div>
                  <div>
                    <dt>连接版本</dt>
                    <dd>{result.configuration.connection.revision}</dd>
                  </div>
                </>
              )}
            </dl>
          </details>
          {Object.entries(result.readiness.stages || {}).map(([key, stage]) => (
            <div key={key} className="terminal-diagnosis-stage" data-status={stage.status}>
              <div className="terminal-diagnosis-stage-heading">
                <strong>{stageLabels[key] || key}</strong>
                <span className="terminal-diagnosis-status" data-status={stage.status}>
                  {stage.status === 'ready' ? '已就绪' : stage.status === 'failed' ? '未通过' : '待确认'}
                </span>
              </div>
              <p
                className="terminal-diagnosis-message"
                role="region"
                aria-label={`${stageLabels[key] || key}阶段完整诊断`}
                tabIndex={0}
              >
                {stage.message}
              </p>
              {stage.code && (
                <details className="terminal-diagnosis-source">
                  <summary>诊断代码</summary>
                  <p
                    className="terminal-diagnosis-reading"
                    role="region"
                    aria-label={`${stageLabels[key] || key}阶段完整诊断代码`}
                    tabIndex={0}
                  >
                    {stage.code}
                  </p>
                </details>
              )}
              {repair && stage.status === 'failed' && key !== 'engine' && (
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || busy}
                  onClick={() =>
                    target(
                      key === 'image' || key === 'cli'
                        ? 'install'
                        : result.configuration.connection
                          ? 'connection'
                          : 'template',
                    )
                  }
                >
                  {
                    labels[
                      key === 'image' || key === 'cli'
                        ? 'install'
                        : result.configuration.connection
                          ? 'connection'
                          : 'template'
                    ]
                  }
                </button>
              )}
            </div>
          ))}
          {!result.readiness.stages && (
            <p
              className="terminal-diagnosis-message"
              role="region"
              aria-label="本地运行环境完整检查结果"
              tabIndex={0}
            >
              {result.readiness.message}
            </p>
          )}
          {result.readiness.code && (
            <details className="terminal-diagnosis-source">
              <summary>环境检查代码</summary>
              <p
                className="terminal-diagnosis-reading"
                role="region"
                aria-label="环境检查完整代码"
                tabIndex={0}
              >
                {result.readiness.code}
              </p>
            </details>
          )}
          {result.configuration.issues.map((issue) => (
            <div className="terminal-diagnosis-issue" key={issue.code} data-severity={issue.severity}>
              <strong>{issue.severity === 'error' ? '配置问题' : '配置提示'}</strong>
              <p
                className="terminal-diagnosis-message"
                role="region"
                aria-label={`配置${issue.severity === 'error' ? '问题' : '提示'}：${issue.code}`}
                tabIndex={0}
              >
                {issue.message}
              </p>
              <details className="terminal-diagnosis-source">
                <summary>配置诊断代码</summary>
                <p
                  className="terminal-diagnosis-reading"
                  role="region"
                  aria-label="配置完整诊断代码"
                  tabIndex={0}
                >
                  {issue.code}
                </p>
              </details>
              {repair && (
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || busy}
                  onClick={() => target(issueKind(issue.code))}
                >
                  {labels[issueKind(issue.code)]}
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
