/* 展示项目文件。 */
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';
import { FilePageControls, formatFileBytes } from './FilePageControls';
import { FileContentView, fileEncodingOptions } from './FileContentView';
import { useFilePage } from './useFilePage';
import './project-files.css';

/**
 * 浏览项目源文件，目录和文件由统一分页读取 Hook 提供。路径、编码和锚点一起形成选择，
 * 项目改变立即回根目录；读取期间明确保留上次来源，不能把旧正文误标为新路径内容。
 */
export function ProjectFiles({ projectId }: { projectId: string }) {
  // 选择状态绑定项目 ID；切换项目时从根目录重新开始。
  const fileListId = useId();
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
  const pathRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const feedback = useRef<'navigation' | 'error' | ''>('');
  const reader = useFilePage(
    '/projects/' + projectId + '/files?path=' + encodeURIComponent(path),
    encoding,
    revision,
  );
  const { value, loading, error } = reader;
  useEffect(() => {
    if (loading || !feedback.current) return;
    const target = error ? errorRef.current : feedback.current === 'navigation' ? pathRef.current : null;
    feedback.current = '';
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [loading, error, path]);
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
    feedback.current = '';
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
          onClick={() => {
            feedback.current = 'navigation';
            choose(parent, false);
          }}
        >
          <Icon name="arrow" size={16} />
        </button>
        <div className="project-files-location">
          <code ref={pathRef} role="region" aria-label="当前项目路径" tabIndex={0}>
            {path === '.' ? '项目文件' : path}
          </code>
          {value?.page && <span className="project-file-size">{formatFileBytes(value.page.totalBytes)}</span>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新文件"
          title="刷新文件"
          disabled={loading}
          onClick={() => {
            feedback.current = 'error';
            setRevision((value) => value + 1);
          }}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      {value && (loading || value.path !== path) && (
        <p className="project-files-read-context" role="status">
          {loading ? '正在读取当前路径，暂时保留上次已读内容。' : '当前显示上次已读内容。'}
          <span>
            已读来源：
            <code className="project-file-reading" role="region" aria-label="已读文件完整来源" tabIndex={0}>
              {value.path}
            </code>
          </span>
        </p>
      )}
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
        <div className="project-file-error" role="alert" ref={errorRef} tabIndex={-1}>
          <span className="project-file-reading" role="region" aria-label="项目文件读取错误全文" tabIndex={0}>
            {error}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              feedback.current = 'navigation';
              reader.restart();
            }}
          >
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
              ref={filterRef}
              type="search"
              aria-label="筛选项目文件"
              aria-describedby={fileListId}
              placeholder="筛选文件"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFilter('');
                  filterRef.current?.focus();
                }}
              >
                清除筛选
              </button>
            )}
          </div>
          <p className="project-file-count" id={fileListId}>
            {filter ? '筛选显示' : '当前显示'} {entries.length} / 已读 {value.entries?.length || 0} 项
            {value.truncated && ' · 目录尚未完整读取'}
          </p>
          <div className="project-file-list" role="region" aria-label="项目目录内容" tabIndex={0}>
            {entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => {
                  feedback.current = 'navigation';
                  choose(entry.path, !entry.directory);
                }}
              >
                <Icon name={entry.directory ? 'folder' : 'file'} size={17} />
                <span className="project-file-name">{entry.name}</span>
                <small>
                  {entry.directory
                    ? '文件夹'
                    : entry.size === undefined
                      ? '文件'
                      : formatFileBytes(entry.size)}
                </small>
              </button>
            ))}
            {!entries.length && (
              <div className="project-file-empty" role="status">
                <p>{filter ? '没有匹配的文件。' : '此文件夹没有文件。'}</p>
              </div>
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
              onLocalLink={(target) => {
                feedback.current = 'navigation';
                choose(target, true);
              }}
              anchor={anchor}
            />
          </>
        )
      )}
    </div>
  );
}
