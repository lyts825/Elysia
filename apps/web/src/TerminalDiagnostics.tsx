import { useEffect, useRef, useState } from 'react';
import type { TerminalProfileDiagnostics } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';

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
  useEffect(() => {
    controller.current?.abort();
    setResult(null);
    setError('');
    setBusy(false);
    return () => controller.current?.abort();
  }, [configKey, profileId, projectId]);
  useEffect(() => {
    if (!recheckRequest || checkedRequest.current === recheckRequest || disabled || busy) return;
    checkedRequest.current = recheckRequest;
    void check().finally(() => rechecked?.());
  }, [recheckRequest, disabled, busy]);
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
    <div className="terminal-diagnostics">
      <button type="button" className="secondary" disabled={disabled || busy} onClick={() => void check()}>
        {busy ? '检查中…' : '检查就绪'}
      </button>
      {error && (
        <p className="terminal-diagnostic-error" role="alert" aria-label="就绪检查失败详情" tabIndex={0}>
          {error}
        </p>
      )}
      {result && (
        <details className="terminal-diagnostic-result" open>
          <summary>
            {result.configuration.ready && result.readiness.available ? '本地运行环境已就绪' : '就绪检查结果'}
          </summary>
          <dl className="terminal-diagnostic-context">
            <div>
              <dt>模板</dt>
              <dd>{result.configuration.profileLabel}</dd>
            </div>
            <div>
              <dt>配置来源</dt>
              <dd>{sourceLabels[result.configuration.source]}</dd>
            </div>
            {result.configuration.connection && (
              <div>
                <dt>连接与模型</dt>
                <dd>
                  {result.configuration.connection.name} / {result.configuration.connection.model}
                </dd>
              </div>
            )}
          </dl>
          {Object.entries(result.readiness.stages || {}).map(([key, stage]) => (
            <div key={key} className="terminal-diagnostic-stage" data-status={stage.status}>
              <div className="terminal-diagnostic-stage-heading">
                <strong>{stageLabels[key] || key}</strong>
                <span className="terminal-diagnostic-status" data-status={stage.status}>
                  {stage.status === 'ready' ? '已就绪' : stage.status === 'failed' ? '未通过' : '待确认'}
                </span>
              </div>
              <p
                className="terminal-diagnostic-message"
                role="region"
                aria-label={`${stageLabels[key] || key}阶段完整诊断`}
                tabIndex={0}
              >
                {stage.message}
              </p>
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
          {!result.readiness.stages && <p className="field-help">{result.readiness.message}</p>}
          {result.configuration.issues.map((issue) => (
            <div className="terminal-diagnostic-issue" key={issue.code} data-severity={issue.severity}>
              <strong>{issue.severity === 'error' ? '配置问题' : '配置提示'}</strong>
              <p
                className="terminal-diagnostic-message"
                role="region"
                aria-label={`配置${issue.severity === 'error' ? '问题' : '提示'}：${issue.code}`}
                tabIndex={0}
              >
                {issue.message}
              </p>
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
