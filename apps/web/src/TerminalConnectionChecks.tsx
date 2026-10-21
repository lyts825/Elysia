import { useEffect, useRef, useState } from 'react';
import type {
  TerminalConnectionProbeResult,
  TerminalConnectionHealth,
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
  const [health, setHealth] = useState<TerminalConnectionHealth | undefined>(connection.health);
  const [catalog, setCatalog] = useState<TerminalConnectionProbeResult | null>(null);
  const [error, setError] = useState('');
  const [errorRequest, setErrorRequest] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const focusError = useRef(false);
  useEffect(() => {
    if (error && focusError.current) {
      focusError.current = false;
      errorElement.current?.focus();
    }
  }, [error, errorRequest]);
  useEffect(() => {
    controller.current?.abort();
    setHealth(connection.health);
    setCatalog(null);
    setError('');
    setBusy(null);
    focusError.current = false;
    if (!enabled) return;
    const request = new AbortController();
    controller.current = request;
    void api<TerminalConnectionHealth>(
      `/terminal/control/connections/${connection.id}/health`,
      undefined,
      undefined,
      request.signal,
    )
      .then((value) => {
        if (
          !request.signal.aborted &&
          value.connectionId === connection.id &&
          value.revision === connection.revision
        )
          setHealth(value);
      })
      .catch((issue) => {
        if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '无法读取验证状态');
      });
    return () => {
      request.abort();
      controller.current?.abort();
    };
  }, [api, connection.id, connection.revision, enabled]);
  async function probe(kind: 'check' | 'models') {
    if (!enabled || busy) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(kind);

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
      ) {
        const { models, resolvedModel: _ignored, ...summary } = value;
        setHealth((previous) => ({
          connectionId: connection.id,
          revision: connection.revision,
          ...previous,
          [kind]: { ...summary, ...(models ? { modelCount: models.length } : {}) },
        }));
        if (kind === 'models') setCatalog(value);
      }
    } catch (issue) {
      if (!request.signal.aborted) {
        focusError.current = true;
        setError(issue instanceof Error ? issue.message : '连接检查未完成');
        setErrorRequest((request) => request + 1);
      }
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
      <div className="terminal-connection-health" aria-label="已保存的连接验证状态">
        {(['check', 'models'] as const).map((kind) => {
          const result = health?.[kind],
            current = enabled && result?.revision === connection.revision;
          return (
            <p
              key={kind}
              role="status"
              className={current && result?.status === 'failed' ? 'cli-app-error' : 'field-help'}
            >
              <strong>{kind === 'check' ? '连接验证' : '模型目录'}</strong>
              <span>
                {!enabled
                  ? '当前修改待保存'
                  : !result
                    ? '尚未检查'
                    : !current
                      ? '配置已变化，待重新检查'
                      : result.message}
              </span>
              {result && (
                <small>
                  上次检查 {new Date(result.checkedAt).toLocaleString()}
                  {current ? ' · ' + result.latencyMs + ' ms' : ''}
                  {kind === 'models' && current && result.modelCount !== undefined
                    ? ' · ' + result.modelCount + ' 个模型'
                    : ''}
                </small>
              )}
            </p>
          );
        })}
      </div>
      {enabled && error && (
        <p role="alert" className="terminal-connection-error" ref={errorElement} tabIndex={-1}>
          {error}
        </p>
      )}
      {enabled && !!catalog?.models?.length && (
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
            {catalog.models!.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
