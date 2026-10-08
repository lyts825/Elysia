import { useEffect, useRef, useState } from 'react';
import { api } from './api';
const encodings = [
  ['auto', '自动'],
  ['utf-8', 'UTF-8'],
  ['utf-16le', 'UTF-16 LE'],
  ['utf-16be', 'UTF-16 BE'],
  ['gb18030', 'GB18030 / GBK'],
] as const;
export function ProjectFiles({ projectId }: { projectId: string }) {
  const [selection, setSelection] = useState({ projectId, path: '.', encoding: 'auto', file: false });
  const { path, encoding, file } =
    selection.projectId === projectId ? selection : { path: '.', encoding: 'auto', file: false };
  const [result, setResult] = useState<{ key: string; value?: any; error?: string; loading: boolean }>({
    key: '',
    loading: true,
  });
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const key = JSON.stringify([projectId, path, encoding, revision]);
  const value = result.key === key ? result.value : undefined;
  const error = result.key === key ? result.error : '';
  const loading = result.key !== key || result.loading;
  const choose = (nextPath: string, nextFile: boolean, nextEncoding = 'auto') => {
    if (nextPath === path && nextEncoding === encoding) return;
    request.current?.abort();
    pending.current = true;
    setSelection({ projectId, path: nextPath, encoding: nextEncoding, file: nextFile });
  };
  useEffect(() => {
    setSelection({ projectId, path: '.', encoding: 'auto', file: false });
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setResult({ key, loading: true });
    api(
      '/projects/' + projectId + '/files?path=' + encodeURIComponent(path) + '&encoding=' + encoding,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (alive && !controller.signal.aborted) setResult({ key, value, loading: false });
      })
      .catch((e) => {
        if (alive && !controller.signal.aborted) setResult({ key, error: e.message, loading: false });
      })
      .finally(() => {
        if (request.current === controller) {
          request.current = null;
          pending.current = false;
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [projectId, path, encoding, key]);
  const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.';
  return (
    <div className="project-files">
      <div className="project-files-toolbar">
        <button className="secondary" disabled={path === '.'} onClick={() => choose(parent, false)}>
          上一级
        </button>
        <code>{path}</code>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => {
            if (loading || pending.current) return;
            pending.current = true;
            setRevision((v) => v + 1);
          }}
        >
          刷新
        </button>
      </div>
      {(file || (value && !value.directory)) && (
        <div className="project-file-encoding">
          <label>
            文本编码
            <select value={encoding} onChange={(e) => choose(path, true, e.target.value)}>
              {encodings.map(([name, label]) => (
                <option key={name} value={name}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="field-help">
            {value?.encoding && (
              <>
                读取编码：{encodings.find(([name]) => name === value.encoding)?.[1] || value.encoding}
                {value.encodingSource === 'bom' ? '（BOM）' : ''}。{' '}
              </>
            )}
            仅改变读取方式，不修改文件。
          </p>
        </div>
      )}
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">正在读取本机文件…</p>}
      {value?.directory ? (
        <div className="project-file-list">
          {value.entries.map((e: any) => (
            <button key={e.path} onClick={() => choose(e.path, !e.directory)}>
              <span>{e.directory ? '文件夹' : '文件'}</span>
              {e.name}
            </button>
          ))}
          {!value.entries.length && <p>此文件夹没有可预览的文件。</p>}
          {value.truncated && <p className="field-help">显示前 300 项。</p>}
        </div>
      ) : (
        value && <pre className="project-file-text">{value.text}</pre>
      )}
    </div>
  );
}
