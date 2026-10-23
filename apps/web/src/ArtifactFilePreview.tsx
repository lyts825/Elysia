import { useEffect, useId, useRef, useState } from 'react';
import { FilePageControls, formatFileBytes } from './FilePageControls';
import { FileContentView, fileEncodingOptions } from './FileContentView';
import { useFilePage } from './useFilePage';
import { useSurfaceClient } from './SurfaceClientContext';
import type { TerminalLogMatch, TerminalLogSearchPage } from '../../../packages/contracts/src/log-search';
import { readingCheckpoint, saveReadingCheckpoint, useReadingScroll } from './ReadingCheckpoint';
import './artifact-file-preview.css';

export interface TerminalLogContext {
  runId: string;
  taskId: string;
}
export function ArtifactFilePreview({
  id,
  logContext,
  checkpointKey,
  resolveLogContext = true,
}: {
  id: string;
  logContext?: TerminalLogContext;
  checkpointKey?: string;
  resolveLogContext?: boolean;
}) {
  const searchIdentity = useId();
  const client = useSurfaceClient(),
    { api } = client;
  const savedKey = JSON.stringify(['artifact', checkpointKey, id]);
  const [encoding, setEncoding] = useState(
    () => readingCheckpoint<{ encoding: string }>(client, savedKey)?.encoding || 'auto',
  );
  const reader = useFilePage('/artifacts/' + id + '/preview', encoding, 0, savedKey);
  const { value, loading, error } = reader;
  const [resolvedContext, setResolvedContext] = useState<{
    runId: string;
    id: string;
    value: TerminalLogContext | null;
  } | null>(null);
  const [contextIssue, setContextIssue] = useState(''),
    [contextRetry, setContextRetry] = useState(0);
  const currentResolvedContext =
    resolvedContext && resolvedContext.runId === checkpointKey && resolvedContext.id === id
      ? resolvedContext
      : null;
  const context = logContext || currentResolvedContext?.value || undefined;
  useEffect(() => {
    if (!resolveLogContext || logContext || !checkpointKey || currentResolvedContext) return;
    const controller = new AbortController();
    setContextIssue('');
    void api<TerminalLogContext | null>(
      `/runs/${checkpointKey}/records/artifacts/${id}/log-context`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setResolvedContext({ runId: checkpointKey, id, value });
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setContextIssue(issue instanceof Error ? issue.message : '无法检查日志检索能力');
      });
    return () => controller.abort();
  }, [api, checkpointKey, id, resolveLogContext, logContext?.runId, logContext?.taskId, contextRetry]);
  const scroll = useReadingScroll(
    client,
    JSON.stringify([savedKey, 'outer', value?.page?.version]),
    !!value && !loading,
  );
  useEffect(() => {
    saveReadingCheckpoint(client, savedKey, { encoding });
  }, [client, savedKey, encoding]);
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
    if (!intent || !context || completed.current === intent.id) return;
    const controller = new AbortController();
    setSearchBusy(true);
    setSearchError('');
    const params = new URLSearchParams({ artifactId: id, q: intent.query, cursor: String(intent.cursor) });
    if (intent.version) params.set('version', intent.version);
    api<TerminalLogSearchPage>(
      `/runs/${context.runId}/tasks/${context.taskId}/terminal-log/search?` + params,
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
  }, [intent, id, context?.runId, context?.taskId]);
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
    <div className="artifact-preview-content" aria-busy={loading} ref={scroll.ref} onScroll={scroll.onScroll}>
      {(!value || value.text !== null) && (
        <div className="artifact-preview-toolbar">
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
          {context && (
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
      {contextIssue && (
        <div className="artifact-preview-issue" role="alert">
          <p
            className="artifact-preview-reading"
            tabIndex={0}
            role="region"
            aria-label="日志检索能力读取问题全文"
          >
            无法检查日志检索能力：{contextIssue}
          </p>
          <button type="button" className="text-button" onClick={() => setContextRetry((value) => value + 1)}>
            重试日志检索能力
          </button>
        </div>
      )}
      {context && searchOpen && (
        <section className="artifact-preview-log" aria-label="完整公开日志检索">
          <h4>检索完整公开日志</h4>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!query.trim() || searchBusy) return;
              setSearchPage(null);
              setTarget(null);
              setIntent({ query: query.trim(), cursor: 0, append: false, id: crypto.randomUUID() });
            }}
          >
            <label>
              日志关键词
              <input
                aria-label="日志关键词"
                type="search"
                maxLength={128}
                placeholder="搜索公开日志"
                value={query}
                aria-describedby={`${searchIdentity}-query-help`}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary" disabled={searchBusy || !query.trim()}>
              {searchBusy ? '搜索中…' : '搜索'}
            </button>
          </form>
          <p className="artifact-preview-log-help" id={`${searchIdentity}-query-help`}>
            {query.length} / 128 字符。搜索范围为此产物的完整公开日志，匹配位置按字节定位。
          </p>
          {searchError && (
            <p
              className="artifact-preview-issue artifact-preview-reading"
              role="alert"
              tabIndex={0}
              aria-label="日志搜索失败全文"
            >
              {searchError}
            </p>
          )}
          {searchPage && (
            <>
              <p className="artifact-preview-log-help" role="status">
                {searchPage.matches.length
                  ? `已显示 ${searchPage.matches.length} 处匹配`
                  : '已扫描部分没有匹配'}
                {' · '}
                {searchPage.nextCursor === null
                  ? '已搜索到日志末尾'
                  : `已扫描至 ${formatFileBytes(searchPage.scannedUntil)}（${searchPage.scannedUntil.toLocaleString()} 字节）`}
              </p>
              {!!searchPage.matches.length && (
                <ol aria-label="日志搜索结果" tabIndex={0}>
                  {searchPage.matches.map((match, index) => (
                    <li key={match.offset}>
                      <div className="artifact-preview-match-heading">
                        <strong>匹配 {index + 1}</strong>
                        <button
                          type="button"
                          disabled={loading}
                          className="secondary"
                          aria-describedby={`${searchIdentity}-match-${index}`}
                          aria-pressed={target?.offset === match.offset}
                          onClick={() => {
                            if (!['auto', 'utf-8'].includes(encoding)) setEncoding('utf-8');
                            setTarget({
                              ...match,
                              version: searchPage.version,
                              requestId: crypto.randomUUID(),
                            });
                          }}
                        >
                          定位此处
                        </button>
                      </div>
                      <small>
                        字节 {match.offset.toLocaleString()}–{match.endOffset.toLocaleString()}（终点不含）
                        {target?.offset === match.offset ? ' · 当前定位' : ''}
                      </small>
                      <p
                        className="artifact-preview-reading"
                        id={`${searchIdentity}-match-${index}`}
                        tabIndex={0}
                        role="region"
                        aria-label={`第 ${index + 1} 处日志匹配全文`}
                      >
                        {match.before}
                        <mark>{match.match}</mark>
                        {match.after}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
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
      {loading && value && <p className="file-read-notice">下方保留上次已读片段，当前读取尚未完成。</p>}
      {error && (
        <div className="artifact-preview-issue" role="alert">
          <p
            className="artifact-preview-reading"
            tabIndex={0}
            role="region"
            aria-label="产物文件读取失败全文"
          >
            {error}
          </p>
          <button className="secondary" type="button" disabled={loading} onClick={reader.restart}>
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
          <FileContentView
            key={id + ':' + encoding}
            file={value}
            highlight={target || undefined}
            checkpointKey={savedKey}
            readingReady={!loading && !error}
          />
        </>
      )}
    </div>
  );
}
