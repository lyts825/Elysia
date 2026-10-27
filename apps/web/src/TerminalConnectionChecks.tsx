/* 展示终端连接检查及结果。 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  TerminalConnectionProbeResult,
  TerminalConnectionHealth,
  TerminalConnectionView,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import './terminal-connection-checks.css';

/**
 * 展示所选连接的验证状态与模型目录。enabled 为假时保留不可操作状态，
 * chooseModel 只接收用户明确选中的模型 ID。
 */
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
  const helpId = useId();
  const [busy, setBusy] = useState<'check' | 'models' | null>(null);
  const [health, setHealth] = useState<TerminalConnectionHealth | undefined>(connection.health);
  const [catalog, setCatalog] = useState<TerminalConnectionProbeResult | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
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
    // 连接或版本切换时取消旧请求，清空目录并读取当前版本的检查状态。
    controller.current?.abort();
    setHealth(connection.health);
    setCatalog(null);
    setSelectedModel('');
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
  /**
   * 取消前次检查并提交当前连接 revision，只有 ID 与 revision 都匹配的响应才更新界面。
   * check 与 models 分别保留健康摘要；模型目录只更新候选列表，不自动替用户选择模型。
   */
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
        // 不把服务端推断的 resolvedModel 当作用户确认；选择必须通过 chooseModel 显式发生。
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
      <h5>连接验证与模型目录</h5>
      <div className="terminal-control-form-actions">
        <button
          type="button"
          className="secondary"
          disabled={!enabled || !!busy}
          aria-describedby={helpId}
          onClick={() => void probe('check')}
        >
          {busy === 'check' ? '验证中…' : '验证连接'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!enabled || !!busy}
          aria-describedby={helpId}
          onClick={() => void probe('models')}
        >
          {busy === 'models' ? '读取中…' : '读取模型目录'}
        </button>
      </div>
      <p className="field-help" id={helpId}>
        {enabled
          ? '验证连接会发送一次小型模型请求，产生少量用量。模型目录不可用时可手填。'
          : '先保存当前修改，再验证连接或读取模型目录。'}
      </p>
      <div className="terminal-check-results" aria-label="已保存的连接验证状态">
        {(['check', 'models'] as const).map((kind) => {
          const result = health?.[kind],
            current = enabled && result?.revision === connection.revision;
          return (
            <article
              key={kind}
              role="status"
              className="terminal-check-result"
              data-status={busy === kind ? 'running' : current ? result?.status : 'waiting'}
              aria-busy={busy === kind}
            >
              <header>
                <strong>{kind === 'check' ? '连接验证' : '模型目录'}</strong>
                <span className="terminal-check-state">
                  {busy === kind
                    ? kind === 'check'
                      ? '正在验证'
                      : '正在读取'
                    : !current
                      ? '待检查'
                      : result?.status === 'passed'
                        ? '已通过'
                        : result?.status === 'failed'
                          ? '未通过'
                          : '不支持'}
                </span>
              </header>
              {busy === kind && (
                <p className="terminal-check-pending">
                  {result ? '本次操作尚未完成，下方暂保留上次检查结果。' : '本次操作尚未完成，请等待结果。'}
                </p>
              )}
              <p
                className="terminal-check-reading"
                tabIndex={0}
                role="region"
                aria-label={kind === 'check' ? '连接验证完整说明' : '模型目录完整说明'}
              >
                {!enabled
                  ? '当前修改待保存'
                  : !result
                    ? '尚未检查'
                    : !current
                      ? '配置已变化，待重新检查'
                      : result.message}
              </p>
              {result && (
                <small>
                  上次检查 {new Date(result.checkedAt).toLocaleString()}
                  {current ? ' · ' + result.latencyMs + ' ms' : ''}
                  {kind === 'models' && current && result.modelCount !== undefined
                    ? ' · ' + result.modelCount + ' 个模型'
                    : ''}
                </small>
              )}
            </article>
          );
        })}
      </div>
      {enabled && error && (
        <p
          role="alert"
          className="terminal-connection-error terminal-check-reading"
          aria-label="连接检查失败详情"
          ref={errorElement}
          tabIndex={0}
        >
          {error}
        </p>
      )}
      {enabled && !busy && catalog?.models?.length === 0 && (
        <p className="terminal-check-empty" role="status">
          已读目录未返回可选模型，可在连接表单中手填型号。
        </p>
      )}
      {enabled && !!catalog?.models?.length && (
        <div className="terminal-check-catalog">
          <label>
            目录中的模型
            <select
              aria-label="选择目录模型"
              defaultValue=""
              onChange={(event) => {
                setSelectedModel(event.target.value);
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
          {selectedModel && (
            <div
              className="terminal-check-choice terminal-check-reading"
              tabIndex={0}
              role="region"
              aria-label="所选目录模型完整名称与标识"
            >
              <strong>{catalog.models!.find((model) => model.id === selectedModel)?.name}</strong>
              <code>{selectedModel}</code>
              <small>已选入表单，保存后生效。</small>
            </div>
          )}
          <details>
            <summary>
              查看本次读取的 {catalog.models!.length} 个模型{catalog.truncated ? '（目录已截取）' : ''}
            </summary>
            <div
              className="terminal-check-reading"
              tabIndex={0}
              role="region"
              aria-label="模型目录完整名称与标识"
            >
              <ul>
                {catalog.models!.map((model) => (
                  <li key={model.id}>
                    <strong>{model.name}</strong>
                    <code>{model.id}</code>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
