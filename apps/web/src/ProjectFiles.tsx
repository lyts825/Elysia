import { useEffect, useState } from 'react';
import { api } from './api';
export function ProjectFiles({ projectId }: { projectId: string }) {
  const [path, setPath] = useState('.'),
    [value, setValue] = useState<any>(),
    [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    setValue(undefined);
    api('/projects/' + projectId + '/files?path=' + encodeURIComponent(path))
      .then((result) => {
        if (alive) setValue(result);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, path, revision]);
  const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.';
  return (
    <div className="project-files">
      <div className="project-files-toolbar">
        <button className="secondary" disabled={path === '.'} onClick={() => setPath(parent)}>
          上一级
        </button>
        <code>{path}</code>
        <button className="secondary" onClick={() => setRevision((v) => v + 1)}>
          刷新
        </button>
      </div>
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {!value && !error && <p>正在读取本机文件…</p>}
      {value?.directory ? (
        <div className="project-file-list">
          {value.entries.map((e: any) => (
            <button key={e.path} onClick={() => setPath(e.path)}>
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
