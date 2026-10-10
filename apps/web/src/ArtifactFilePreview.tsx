import { useEffect, useRef, useState } from 'react';
import { FilePageControls, formatFileBytes } from './FilePageControls';
import { FileContentView, fileEncodingOptions } from './FileContentView';
import { useFilePage } from './useFilePage';
import { useSurfaceClient } from './SurfaceClientContext';
import type { TerminalLogMatch, TerminalLogSearchPage } from '../../../packages/contracts/src/log-search';

export interface TerminalLogContext {
  runId: string;
  taskId: string;
}
export function ArtifactFilePreview({ id, logContext }: { id: string; logContext?: TerminalLogContext }) {
  const { api } = useSurfaceClient();
  const [encoding, setEncoding] = useState('auto');
  const reader = useFilePage('/artifacts/' + id + '/preview', encoding, 0);
  const { value, loading, error } = reader;
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState('');
  const [intent, setIntent] = useState<{
    query: string;
    cursor: number;
    version?: string;
    append: boolean;
    id: string;
  } | null>(null);
  const [searchPage, setSearchPage] = useState<TerminalLogSearchPage | null>(null);
  const [searchBusy, setSearchBusy] = useState(false),
    [searchError, setSearchError] = useState('');
  const completed = useRef('');
  const [target, setTarget] = useState<(TerminalLogMatch & { requestId: string; version: string }) | null>(
    null,
  );
  useEffect(() => {
    if (!intent || !logContext || completed.current === intent.id) return;
    const controller = new AbortController();
    setSearchBusy(true);
    setSearchError('');
    const params = new URLSearchParams({ artifactId: id, q: intent.query, cursor: String(intent.cursor) });
    if (intent.version) params.set('version', intent.version);
    api<TerminalLogSearchPage>(
      `/runs/${logContext.runId}/tasks/${logContext.taskId}/terminal-log/search?` + params,
      undefined,
      undefined,
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        completed.current = intent.id;
        setSearchPage((old) =>
          intent.append && old?.query === page.query && old.version === page.version
            ? {
                ...page,
                matches: [...old.matches, ...page.matches]
                  .filter(
                    (match, index, all) => all.findIndex((other) => other.offset === match.offset) === index,
                  )
                  .slice(-300),
              }
            : page,
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        completed.current = intent.id;
        setSearchError(error instanceof Error ? error.message : '搜索失败，请重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchBusy(false);
      });
    return () => controller.abort();
  }, [intent, id, logContext?.runId, logContext?.taskId]);
  useEffect(() => {
    if (!target || loading || !value?.page || value.encoding !== 'utf-8') return;
    if (target.version !== value.page.version) {
      setTarget(null);
      setSearchError('日志已变化，请重新搜索。');
      return;
    }
    if (target.offset < value.page.offset || target.endOffset > value.page.endOffset)
      reader.jump(Math.max(0, target.offset - 2048));
  }, [target, loading, value?.page?.offset, value?.page?.version, value?.encoding]);
  return (
    <div className="artifact-file-preview" aria-busy={loading}>
      {(!value || value.text !== null) && (
        <div className="file-encoding-choice">
          <label>
            编码{' '}
            <select
              aria-label="文本编码"
              value={encoding}
              disabled={loading}
              onChange={(event) => setEncoding(event.target.value)}
            >
              {fileEncodingOptions.map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {logContext && (
            <button
              type="button"
              className="quiet-button"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (searchOpen) {
                  setIntent(null);
                  setSearchBusy(false);
                }
              }}
            >
              搜索完整日志
            </button>
          )}
        </div>
      )}
      {logContext && searchOpen && (
        <section className="terminal-log-search" aria-label="完整公开日志检索">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!query.trim() || searchBusy) return;
              setSearchPage(null);
              setTarget(null);
              setIntent({ query: query.trim(), cursor: 0, append: false, id: crypto.randomUUID() });
            }}
          >
            <input
              aria-label="日志关键词"
              type="search"
              maxLength={128}
              placeholder="搜索公开日志"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="secondary" disabled={searchBusy || !query.trim()}>
              {searchBusy ? '搜索中…' : '搜索'}
            </button>
          </form>
          {searchError && (
            <p className="file-read-notice" role="alert">
              {searchError}
            </p>
          )}
          {searchPage && (
            <>
              <p className="terminal-log-search-status" role="status">
                {searchPage.matches.length
                  ? `已显示 ${searchPage.matches.length} 处匹配`
                  : '已扫描部分没有匹配'}
                {' · '}
                {searchPage.nextCursor === null
                  ? '已搜索到日志末尾'
                  : `已扫描至 ${formatFileBytes(searchPage.scannedUntil)}`}
              </p>
              <ol aria-label="日志搜索结果">
                {searchPage.matches.map((match) => (
                  <li key={match.offset}>
                    <button
                      type="button"
                      disabled={loading}
                      aria-pressed={target?.offset === match.offset}
                      onClick={() => {
                        if (!['auto', 'utf-8'].includes(encoding)) setEncoding('utf-8');
                        setTarget({ ...match, version: searchPage.version, requestId: crypto.randomUUID() });
                      }}
                    >
                      <small>位置 {formatFileBytes(match.offset)}</small>
                      <span>
                        {match.before}
                        <mark>{match.match}</mark>
                        {match.after}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {searchPage.nextCursor !== null && (
                <button
                  type="button"
                  className="secondary"
                  disabled={searchBusy}
                  onClick={() =>
                    setIntent({
                      query: searchPage.query,
                      cursor: searchPage.nextCursor!,
                      version: searchPage.version,
                      append: true,
                      id: crypto.randomUUID(),
                    })
                  }
                >
                  {searchBusy ? '搜索中…' : '继续搜索'}
                </button>
              )}
            </>
          )}
        </section>
      )}
      {reader.notice && (
        <p className="file-read-notice" role="status">
          {reader.notice}
        </p>
      )}
      {loading && (
        <p className="file-loading" role="status">
          正在核对并读取产物…
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
      {value && (
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
          <FileContentView key={id + ':' + encoding} file={value} highlight={target || undefined} />
        </>
      )}
    </div>
  );
}
