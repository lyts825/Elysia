import { useEffect, useRef, useState } from 'react';
import type { TerminalProfileDiagnostics } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';

type Readiness = {
  available: boolean;
  message: string;
  stages?: Record<string, { status: string; message: string }>;
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
}: {
  profileId: string;
  projectId?: string;
  configKey: string;
  disabled?: boolean;
}) {
  const { api } = useSurfaceClient();
  const [result, setResult] = useState<{
    configuration: TerminalProfileDiagnostics;
    readiness: Readiness;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    setResult(null);
    setError('');
    setBusy(false);
    return () => controller.current?.abort();
  }, [configKey, profileId, projectId]);
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
      const readiness = await api<Readiness>(
        '/terminal/check',
        { profileId, ...(projectId ? { projectId } : {}) },
        undefined,
        request.signal,
      );
      if (!request.signal.aborted) setResult({ configuration, readiness });
    } catch (issue) {
      if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '就绪检查未完成');
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
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
            </p>
          ))}
          {!result.readiness.stages && <p className="field-help">{result.readiness.message}</p>}
          {result.configuration.issues.map((issue) => (
            <p className={issue.severity === 'error' ? 'cli-app-error' : 'field-help'} key={issue.code}>
              {issue.message}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
