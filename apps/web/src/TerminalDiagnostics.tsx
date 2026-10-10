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
      <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void check()}>
        {busy ? '检查中…' : '检查就绪'}
      </button>
      {error && (
        <p className="cli-app-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <details open>
          <summary>
            {result.configuration.ready && result.readiness.available ? '本地运行环境已就绪' : '就绪检查结果'}
          </summary>
          <p className="field-help">
            {result.configuration.profileLabel} · {sourceLabels[result.configuration.source]}
            {result.configuration.connection &&
              ` · ${result.configuration.connection.name} / ${result.configuration.connection.model}`}
          </p>
          {Object.entries(result.readiness.stages || {}).map(([key, stage]) => (
            <p key={key} className="terminal-diagnostic-stage">
              <span>{stageLabels[key] || key}</span>
              <span className={stage.status === 'failed' ? 'cli-app-error' : ''}>
                {stage.status === 'ready' ? '✓ ' : stage.status === 'failed' ? '× ' : '○ '}
                {stage.message}
              </span>
              {repair && stage.status === 'failed' && key !== 'engine' && (
                <button
                  type="button"
                  className="text-button"
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
            </p>
          ))}
          {!result.readiness.stages && <p className="field-help">{result.readiness.message}</p>}
          {result.configuration.issues.map((issue) => (
            <div className="terminal-diagnostic-issue" key={issue.code}>
              <p className={issue.severity === 'error' ? 'cli-app-error' : 'field-help'}>{issue.message}</p>
              {repair && (
                <button
                  type="button"
                  className="text-button"
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
