/** 按需读取当前入口诊断，导出用户已查看的快照；卸载或切换入口后取消读取。
 * EN: Read diagnostics on demand and export the viewed snapshot; cancel reads on unmount or surface change.
 */
import { useEffect, useRef, useState } from 'react';
import type { RuntimeDiagnosticSnapshot } from '../../../packages/contracts/src/diagnostics';
import { useSurfaceClient } from './SurfaceClientContext';

export function RuntimeDiagnostics() {
  const client = useSurfaceClient();
  const pending = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeDiagnosticSnapshot>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setSnapshot(undefined);
    setError('');
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [client]);
  async function read() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await client.api<RuntimeDiagnosticSnapshot>(
        '/diagnostics',
        undefined,
        'GET',
        controller.signal,
      );
      if (pending.current === controller && !controller.signal.aborted) setSnapshot(value);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '诊断读取失败');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function download() {
    if (!snapshot) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `elysia-diagnostics-${snapshot.surface}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <details
      className="startup-diagnostics"
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open && !snapshot && !busy)
          void read();
      }}
    >
      <summary>运行诊断</summary>
      <p className="startup-settings-hint">
        记录本次服务启动后的请求数量、耗时和错误编号，重启后清空。导出内容不含会话正文、请求参数、文件路径或密钥。
      </p>
      <div className="startup-preferences-actions">
        <button className="secondary" disabled={busy} onClick={() => void read()}>
          {busy ? '正在读取…' : '刷新诊断'}
        </button>
        <button className="secondary" disabled={!snapshot} onClick={download}>
          导出已读诊断
        </button>
      </div>
      {error && (
        <p role="alert">
          {error}
          {snapshot ? '。下方保留上次已读诊断。' : ''}
        </p>
      )}
      {snapshot && (
        <>
          <p className="startup-settings-hint">
            {snapshot.surface === 'native' ? '原生模型' : 'Agent 终端'} · v{snapshot.version} · 采集于{' '}
            {new Date(snapshot.capturedAt).toLocaleString()}
          </p>
          <dl className="startup-preferences-record">
            <div>
              <dt>请求</dt>
              <dd>
                {snapshot.requests.total} 次，失败 {snapshot.requests.failed} 次，进行中{' '}
                {snapshot.requests.active} 次
              </dd>
            </div>
            <div>
              <dt>服务内存</dt>
              <dd>{(snapshot.memory.rssBytes / 1024 / 1024).toFixed(1)} MiB</dd>
            </div>
            <div>
              <dt>事件循环延迟 P95</dt>
              <dd>{snapshot.eventLoop.p95Ms} ms</dd>
            </div>
          </dl>
          <p className="startup-settings-hint">
            内存与事件循环指标属于两入口共用的服务进程；请求统计只属于当前入口。路由 P95 使用最近最多 128
            个样本。
          </p>
          {snapshot.errors.length ? (
            <details>
              <summary>最近错误（{snapshot.errors.length} 条）</summary>
              <p>下方显示最近 8 条，导出包含最多 64 条。</p>
              <ul>
                {snapshot.errors
                  .slice(-8)
                  .reverse()
                  .map((item, index) => (
                    <li key={item.requestId ?? `${item.at}-${index}`}>
                      <span>
                        {item.code} · HTTP {item.statusCode}
                      </span>
                      <br />
                      <code style={{ overflowWrap: 'anywhere' }}>{item.requestId ?? '后台任务'}</code>
                    </li>
                  ))}
              </ul>
            </details>
          ) : (
            <p>本次运行暂无错误记录。</p>
          )}
        </>
      )}
    </details>
  );
}
