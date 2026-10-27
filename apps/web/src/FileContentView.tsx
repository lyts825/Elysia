/**
 * 展示文件文本内容及编码选项。
 * 统一处理源码、编码、行定位和阅读区域展示，保留原始文本；分页请求和版本选择由调用方提供。
 * EN: Displays file content and encoding-related options. Shares source, encoding, line-location, and reading-region presentation while retaining original text; callers supply paginated content and revision selection.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownDocument } from './MarkdownDocument';
import type { FilePreviewContent } from './useFilePage';
import './file-content.css';
import { useSurfaceClient } from './SurfaceClientContext';
import { readingCheckpoint, saveReadingCheckpoint, useReadingScroll } from './ReadingCheckpoint';

export const fileEncodingOptions = [
  ['auto', '自动'],
  ['utf-8', 'UTF-8'],
  ['utf-16le', 'UTF-16 LE'],
  ['utf-16be', 'UTF-16 BE'],
  ['gb18030', 'GB18030 / GBK'],
] as const;

/**
 * 按媒体类型呈现已读片段：Markdown 可切文档/源码，图片与 PDF 使用受限资源 URL，
 * 其他二进制仅提示下载。搜索命中强制采用源码显示，但不覆盖用户保存的显示偏好。
 * 阅读位置还绑定文件版本、页偏移和编码，正文未 ready 时不恢复或写入滚动位置。
 * EN: Render loaded fragments according to media type. Markdown can switch document/source mode; images and PDFs use restricted resource URLs; other binaries offer download only. Search hits force source mode without overwriting the saved preference. Position is also bound to file version, page offset, and encoding; do not restore or save it before content is ready.
 */
export function FileContentView({
  file,
  onLocalLink,
  anchor,
  highlight,
  checkpointKey,
  readingReady = true,
}: {
  file: FilePreviewContent;
  onLocalLink?: (path: string) => void;
  anchor?: string;
  highlight?: { offset: number; endOffset: number; requestId: string };
  checkpointKey?: string;
  readingReady?: boolean;
}) {
  const client = useSurfaceClient();
  const savedKey = JSON.stringify(['content-view', checkpointKey, file.path]);
  /**
   * 文档／源码模式与换行选项按文件保存，滚动位置还区分页、版本和编码。
   * EN: Save document/source mode and wrapping per file; distinguish scroll positions by page, version, and encoding as well.
   */
  const saved = checkpointKey
    ? readingCheckpoint<{ mode: 'document' | 'source'; wrap: boolean }>(client, savedKey)
    : undefined;
  const [mode, setMode] = useState<'document' | 'source'>(saved?.mode || 'document');
  const [wrap, setWrap] = useState(saved?.wrap || false);
  const scrollKey = JSON.stringify([savedKey, file.page?.version, file.page?.offset, file.encoding, mode]);
  const documentScroll = useReadingScroll(client, scrollKey, !!checkpointKey && readingReady);
  const sourceScroll = useReadingScroll<HTMLPreElement>(client, scrollKey, !!checkpointKey && readingReady);
  /**
   * 源码显示模式或换行偏好变化时按阅读键保存检查点，跨文件偏好由独立键隔离。
   * EN: Persists source-display mode and wrap preferences by reading key, isolating different files with separate keys.
   */
  useLayoutEffect(() => {
    if (checkpointKey) saveReadingCheckpoint(client, savedKey, { mode, wrap });
  }, [client, checkpointKey, savedKey, mode, wrap]);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const highlighted = useRef<HTMLElement>(null);
  const scrolledHighlight = useRef('');
  /**
   * 搜索给出的是 UTF-8 字节区间，先扣除首页 BOM 再转换成 JavaScript 字符索引。
   * EN: Search ranges are UTF-8 byte offsets. Subtract a first-page BOM before converting them into JavaScript string indexes.
   */
  const range = useMemo(() => {
    if (
      !highlight ||
      !file.page ||
      file.text === null ||
      file.encoding !== 'utf-8' ||
      highlight.offset < file.page.offset ||
      highlight.endOffset > file.page.endOffset
    )
      return null;
    const bytes = new TextEncoder().encode(file.text);
    const bom = file.encodingSource === 'bom' && file.page.offset === 0 ? 3 : 0;
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    return {
      start: decoder.decode(bytes.subarray(0, highlight.offset - file.page.offset - bom)).length,
      end: decoder.decode(bytes.subarray(0, highlight.endOffset - file.page.offset - bom)).length,
    };
  }, [file.text, file.page?.offset, file.page?.endOffset, file.encoding, file.encodingSource, highlight]);
  /**
   * 行高亮请求或范围变化后定位目标行，在布局完成后滚动和标记；重复渲染不重放相同定位。
   * EN: Locates the requested line after highlight/range changes and layout completion, applying scrolling/marking without replaying identical requests on ordinary renders.
   */
  useLayoutEffect(() => {
    const key = JSON.stringify([highlight?.requestId, file.page?.offset]);
    if (range && highlighted.current && scrolledHighlight.current !== key) {
      scrolledHighlight.current = key;
      highlighted.current.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
  }, [highlight?.requestId, range]);
  const markdown = file.kind === 'markdown' || /\.(?:md|markdown)$/i.test(file.path);
  const documentView = markdown && mode === 'document' && !highlight;
  const encodingSource =
    file.encodingSource === 'bom'
      ? 'BOM 识别'
      : file.encodingSource === 'manual'
        ? '手动选择'
        : file.encodingSource === 'default'
          ? '默认编码'
          : '来源未提供';
  return (
    <div className="file-content-view">
      <details className="file-content-info">
        <summary>
          文件信息{file.text !== null ? ` · 已显示 ${file.text.length.toLocaleString()} 字符` : ''}
        </summary>
        <dl
          className="file-content-info-reading"
          tabIndex={0}
          role="region"
          aria-label="当前文件完整路径与读取信息"
        >
          <div>
            <dt>文件路径</dt>
            <dd>{file.path}</dd>
          </div>
          {file.mediaType && (
            <div>
              <dt>内容类型</dt>
              <dd>{file.mediaType}</dd>
            </div>
          )}
          {file.encoding && (
            <div>
              <dt>文本编码</dt>
              <dd>
                {file.encoding.toUpperCase()} · {encodingSource}
              </dd>
            </div>
          )}
          {file.text !== null && (
            <div>
              <dt>显示范围</dt>
              <dd>
                {file.page?.paged ? '当前读取片段' : '当前已读内容'} · {file.text.length.toLocaleString()}{' '}
                字符；字符数不等于文件字节数。
              </dd>
            </div>
          )}
        </dl>
      </details>
      {file.text !== null && (
        <div className="file-content-tools">
          {markdown && (
            <div className="file-content-tabs" role="group" aria-label="文件显示方式">
              <button type="button" aria-pressed={documentView} onClick={() => setMode('document')}>
                文档
              </button>
              <button type="button" aria-pressed={!documentView} onClick={() => setMode('source')}>
                源码
              </button>
            </div>
          )}
          {!documentView && (
            <label className="file-wrap-control">
              <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
              自动换行
            </label>
          )}
          {file.encoding && (
            <span className="file-content-encoding">
              {file.encoding.toUpperCase()} · {encodingSource}
            </span>
          )}
        </div>
      )}
      {highlight && file.text !== null && (
        <p className="file-highlight-view-note">搜索定位使用源码视图，原显示偏好仍保留。</p>
      )}
      {documentView && file.text !== null ? (
        <>
          {file.page?.paged && (
            <p className="file-fragment-note">大文档按片段显示。跨片段的代码块、表格或引用可切换源码查看。</p>
          )}
          <div
            className="file-document-scroll"
            role="region"
            aria-label={'文档内容 · ' + file.path}
            tabIndex={0}
            key={file.page?.offset || 0}
            ref={documentScroll.ref}
            onScroll={documentScroll.onScroll}
          >
            <MarkdownDocument
              text={file.text}
              sourcePath={file.path}
              resourceBase={file.resourceBase}
              onLocalLink={onLocalLink}
              anchor={anchor}
            />
          </div>
        </>
      ) : file.text !== null ? (
        <pre
          key={file.page?.offset || 0}
          className={'file-source-scroll' + (wrap ? ' wrapped' : '')}
          role="region"
          aria-label={'文件源码 · ' + file.path}
          tabIndex={0}
          ref={sourceScroll.ref}
          onScroll={sourceScroll.onScroll}
        >
          {range && file.text ? (
            <>
              {file.text.slice(0, range.start)}
              <mark ref={highlighted} className="file-search-hit">
                {file.text.slice(range.start, range.end)}
              </mark>
              {file.text.slice(range.end)}
            </>
          ) : (
            file.text || '空文件'
          )}
        </pre>
      ) : file.kind === 'image' && file.resourceUrl && failedImage !== file.resourceUrl ? (
        <div className="file-image-scroll">
          <img
            src={file.resourceUrl}
            alt={file.path}
            decoding="async"
            onError={() => setFailedImage(file.resourceUrl)}
          />
        </div>
      ) : file.mediaType?.startsWith('application/pdf') && file.resourceUrl ? (
        <iframe className="file-pdf-view" title={'PDF 文档 · ' + file.path} src={file.resourceUrl} />
      ) : (
        <div className="file-content-empty">
          <strong>{file.kind === 'image' ? '图片无法显示' : '此格式需要对应应用打开'}</strong>
          <p>文件已读取，可下载后查看。</p>
        </div>
      )}
    </div>
  );
}

/**
 * 高亮服务端已定位到片段开头的行范围，不为全文每行创建 DOM 节点。
 * requestId 保证同一定位只滚动一次；文字变化但请求不变不会反复夺走用户阅读位置。
 * EN: Highlight the line range that the server has located at the fragment start, rather than creating DOM nodes for every line in the whole file. requestId permits one scroll per navigation; text updates under the same request must not repeatedly take the reader's position.
 */
export function SourceText({
  text,
  line,
  endLine,
  requestId,
  checkpointKey,
  className = 'preview-source',
}: {
  text: string;
  line?: number;
  endLine?: number;
  requestId?: string;
  checkpointKey?: string;
  className?: string;
}) {
  const client = useSurfaceClient();
  const scroll = useReadingScroll<HTMLPreElement>(
    client,
    (checkpointKey || '') + ':source-scroll',
    !!checkpointKey,
  );
  const target = useRef<HTMLElement>(null),
    handled = useRef('');
  let end = 0;
  if (line && endLine) {
    for (let count = 0; count <= endLine - line; count++) {
      const newline = text.indexOf('\n', end);
      if (newline < 0) {
        end = text.length;
        break;
      }
      end = newline + 1;
    }
  }
  /**
   * 请求ID或源码文本变化后重新完成行定位，使分页正文加载完成后仍能响应先前目标。
   * EN: Reapplies line location after request-ID or source-text changes so a target can resolve after paginated text arrives.
   */
  useLayoutEffect(() => {
    if (requestId && target.current && handled.current !== requestId) {
      handled.current = requestId;
      target.current.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    }
  }, [requestId, text]);
  return (
    <pre className={className} ref={scroll.ref} onScroll={scroll.onScroll}>
      {line ? (
        <>
          <mark
            ref={target}
            className="file-line-hit"
            aria-label={`第 ${line}${endLine && endLine !== line ? `–${endLine}` : ''} 行`}
          >
            {text.slice(0, end) || ' '}
          </mark>
          {text.slice(end)}
        </>
      ) : (
        text
      )}
    </pre>
  );
}
