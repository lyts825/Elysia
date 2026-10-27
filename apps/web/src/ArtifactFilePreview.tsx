/**
 * 展示产物文件内容，并支持终端日志上下文。
 * 把冻结产物或终端日志来源交给统一文件阅读视图，管理读取与定位；不从文件名推断其他版本正文。
 * EN: Previews artifact file content and optionally exposes terminal log context. Routes frozen artifacts or terminal-log sources through the shared file reader with loading and location state; it does not infer another revision from a filename.
 */
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
/**
 * 读取指定产物的有界预览，并按产物/检查点恢复编码和阅读位置。
 * logContext 可由调用方直接提供；缺省时只在允许且有运行检查点的情况下查询日志能力，
 * 普通产物不因此获得终端日志搜索权限。
 * EN: Reads a bounded artifact preview and restores encoding and reading position per artifact and checkpoint. The caller may provide logContext; otherwise log capability is queried only when permitted and a run checkpoint exists. An ordinary artifact gains no terminal log search permission from being previewed.
 */
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
  /**
   * 文件编码和分页位置按产物与检查点隔离，重新打开时可恢复阅读状态。
   * EN: Keep encoding and pagination positions isolated by artifact and checkpoint so reopening can restore the correct reading state.
   */
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
  /**
   * 解析结果以运行与产物双重身份缓存；切换对象时取消旧请求，不让迟到结果覆盖当前上下文。
   * EN: Cache resolved context under both run and artifact identity. Cancel the old request when switching objects so late results cannot overwrite the current context.
   */
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
  /**
   * 按客户端和阅读键保存编码偏好；编码变化只更新检查点，不主动修改文件内容。
   * EN: Persists encoding preference by client and reading key; encoding changes update the checkpoint without modifying file content.
   */
  useEffect(() => {
    saveReadingCheckpoint(client, savedKey, { encoding });
  }, [client, savedKey, encoding]);
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState('');
  /**
   * query 是正在输入的文字，intent 才是已提交搜索；继续搜索沿用已读关键词与日志版本。
   * EN: query is the input being edited; intent is a submitted search. Continuing a search keeps the loaded term and log version.
   */
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
  /**
   * intent.id 区分同一关键词的显式重试，completed 阻止 effect 重渲染重复提交已结束请求。
   * EN: intent.id distinguishes an explicit retry of the same term; completed prevents rerenders from resubmitting an already finished request.
   */
  const completed = useRef('');
  const [target, setTarget] = useState<(TerminalLogMatch & { requestId: string; version: string }) | null>(
    null,
  );
  /**
   * 按搜索意图、产物和终端任务身份读取日志匹配页；同查询/版本才追加，切换或卸载取消，结果有界去重。
   * EN: Reads log matches by search intent, artifact, and terminal-task identity, appending only the same query/revision with bounded deduplication; changes or teardown abort the request.
   */
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
        /**
         * 只有同一查询、同一文件版本才能追加；按字节起点去重并保留最近 300 条匹配。
         * EN: Append only for the same query and file version, deduplicate by starting byte offset, and retain at most the latest 300 matches.
         */
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
    /**
     * 日志匹配使用 UTF-8 字节定位，先等对应编码页就绪；文件版本变动后旧匹配不再可定位。
     * EN: Log matches use UTF-8 byte positions. Wait for the corresponding encoded page before locating them; a file-version change invalidates old matches.
     */
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
              {searchOpen ? '收起日志搜索' : '搜索完整日志'}
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
            <button
              type="submit"
              className="secondary"
              disabled={searchBusy || !query.trim()}
              aria-describedby={`${searchIdentity}-query-help`}
            >
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
              <div className="artifact-preview-search-basis">
                <span>已读关键词</span>
                <p
                  id={`${searchIdentity}-read-query`}
                  className="artifact-preview-reading"
                  tabIndex={0}
                  role="region"
                  aria-label="已读日志搜索完整关键词"
                >
                  {searchPage.query}
                </p>
                {query.trim() !== searchPage.query && (
                  <p className="artifact-preview-log-help">输入已改动，当前结果仍对应以上关键词。</p>
                )}
              </div>
              <p id={`${searchIdentity}-read-status`} className="artifact-preview-log-help" role="status">
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
                  aria-describedby={`${searchIdentity}-read-query ${searchIdentity}-read-status`}
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
