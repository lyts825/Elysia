import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { FilePageControls, formatFileBytes } from './FilePageControls';
import { FileContentView, fileEncodingOptions } from './FileContentView';
import { useFilePage } from './useFilePage';
import './project-files.css';

export function ProjectFiles({ projectId }: { projectId: string }) {
  const [selection, setSelection] = useState({
    projectId,
    path: '.',
    encoding: 'auto',
    file: false,
    anchor: '',
  });
  const { path, encoding, file, anchor } =
    selection.projectId === projectId ? selection : { path: '.', encoding: 'auto', file: false, anchor: '' };
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState('');
  const reader = useFilePage(
    '/projects/' + projectId + '/files?path=' + encodeURIComponent(path),
    encoding,
    revision,
  );
  const { value, loading, error } = reader;
  const choose = (next: string, isFile: boolean, nextEncoding = 'auto') => {
    setFilter('');
    const hash = next.indexOf('#');
    setSelection({
      projectId,
      path: hash < 0 ? next : next.slice(0, hash),
      encoding: nextEncoding,
      file: isFile,
      anchor: hash < 0 ? '' : next.slice(hash + 1),
    });
  };
  useEffect(() => {
    setSelection({ projectId, path: '.', encoding: 'auto', file: false, anchor: '' });
    setFilter('');
  }, [projectId]);
  const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.';
  const entries =
    value?.entries?.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())) || [];
  return (
    <div className="project-files" aria-busy={loading}>
      <div className="project-files-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="上一级文件夹"
          title="上一级文件夹"
          disabled={path === '.'}
          onClick={() => choose(parent, false)}
        >
          <Icon name="arrow" size={16} />
        </button>
        <code title={path}>{path === '.' ? '项目文件' : path}</code>
        {value?.page && <span className="project-file-size">{formatFileBytes(value.page.totalBytes)}</span>}
        <button
          type="button"
          className="icon-button"
          aria-label="刷新文件"
          title="刷新文件"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      {(value ? !value.directory : file) && (
        <div className="file-encoding-choice">
          {(value?.text !== null || !value) && (
            <label>
              编码{' '}
              <select
                aria-label="文本编码"
                value={encoding}
                disabled={loading}
                onChange={(event) => choose(path, true, event.target.value)}
              >
                {fileEncodingOptions.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {value?.resourceUrl && (
            <a className="file-download-link" href={value.resourceUrl} download={path.split('/').at(-1)}>
              下载
            </a>
          )}
        </div>
      )}
      {reader.notice && (
        <p className="file-read-notice" role="status">
          {reader.notice}
        </p>
      )}
      {error && (
        <div className="inline-warning" role="alert">
          <span>{error}</span>
          <button type="button" disabled={loading} onClick={reader.restart}>
            重试
          </button>
        </div>
      )}
      {loading && (
        <p className="file-loading" role="status">
          正在读取文件…
        </p>
      )}
      {value?.directory ? (
        <>
          <div className="project-file-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              aria-label="筛选项目文件"
              placeholder="筛选文件"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="project-file-list">
            {entries.map((entry) => (
              <button type="button" key={entry.path} onClick={() => choose(entry.path, !entry.directory)}>
                <Icon name={entry.directory ? 'folder' : 'file'} size={17} />
                <span className="project-file-name">{entry.name}</span>
                <small>
                  {entry.directory ? '文件夹' : entry.size === undefined ? '' : formatFileBytes(entry.size)}
                </small>
              </button>
            ))}
            {!entries.length && (
              <p className="file-read-notice">{filter ? '没有匹配的文件。' : '此文件夹没有文件。'}</p>
            )}
            {value.truncated && <p className="file-read-notice">目录显示前 300 项；进入子目录可继续浏览。</p>}
          </div>
        </>
      ) : (
        value && (
          <>
            {value.page?.paged && (
              <FilePageControls
                page={value.page}
                loading={loading}
                hasPrevious={reader.hasPrevious}
                previous={reader.previous}
                next={reader.next}
                jump={reader.jump}
                restart={reader.restart}
              />
            )}
            <FileContentView
              key={projectId + ':' + path + ':' + encoding}
              file={value}
              onLocalLink={(target) => choose(target, true)}
              anchor={anchor}
            />
          </>
        )
      )}
    </div>
  );
}
