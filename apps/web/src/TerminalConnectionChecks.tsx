import { useEffect, useRef, useState } from 'react';
import type {
  TerminalConnectionProbeResult,
  TerminalConnectionView,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';

export function TerminalConnectionChecks({
  connection,
  enabled,
  chooseModel,
}: {
  connection: TerminalConnectionView;
  enabled: boolean;
  chooseModel: (model: string) => void;
}) {
  const { api } = useSurfaceClient();
  const [busy, setBusy] = useState<'check' | 'models' | null>(null);
  const [result, setResult] = useState<TerminalConnectionProbeResult | null>(null);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    setResult(null);
    setError('');
    setBusy(null);
    return () => controller.current?.abort();
  }, [connection.id, connection.revision, enabled]);
  async function probe(kind: 'check' | 'models') {
    if (!enabled || busy) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(kind);
    setResult(null);
    setError('');
    try {
      const value = await api<TerminalConnectionProbeResult>(
        `/terminal/control/connections/${connection.id}/${kind}`,
        { expectedRevision: connection.revision },
        undefined,
        request.signal,
      );
      if (
        !request.signal.aborted &&
        value.connectionId === connection.id &&
        value.revision === connection.revision
      )
        setResult(value);
    } catch (issue) {
      if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '连接检查未完成');
    } finally {
      if (controller.current === request && !request.signal.aborted) setBusy(null);
    }
  }
  return (
    <div className="terminal-connection-checks">
      <div className="terminal-control-form-actions">
        <button
          type="button"
          className="secondary"
          disabled={!enabled || !!busy}
          onClick={() => void probe('check')}
        >
          {busy === 'check' ? '验证中…' : '验证连接'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!enabled || !!busy}
          onClick={() => void probe('models')}
        >
          {busy === 'models' ? '读取中…' : '读取模型目录'}
        </button>
      </div>
      <p className="field-help">
        {enabled
          ? '验证连接会发送一次小型模型请求，产生少量用量。模型目录不可用时可手填。'
          : '先保存当前修改，再验证连接或读取模型目录。'}
      </p>
      {enabled && result && (
        <p role="status" className={result.status === 'failed' ? 'cli-app-error' : 'field-help'}>
          {result.message}
          {result.status === 'passed' && ` · ${result.latencyMs} ms`}
        </p>
      )}
      {enabled && error && (
        <p role="alert" className="cli-app-error">
          {error}
        </p>
      )}
      {enabled && !!result?.models?.length && (
        <label>
          目录中的模型
          <select
            aria-label="选择目录模型"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) chooseModel(event.target.value);
            }}
          >
            <option value="">选择模型后保存…</option>
            {result.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.id}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
