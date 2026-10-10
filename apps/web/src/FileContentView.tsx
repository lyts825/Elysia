import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownDocument } from './MarkdownDocument';
import type { FilePreviewContent } from './useFilePage';
import './file-content.css';

export const fileEncodingOptions = [
  ['auto', '自动'],
  ['utf-8', 'UTF-8'],
  ['utf-16le', 'UTF-16 LE'],
  ['utf-16be', 'UTF-16 BE'],
  ['gb18030', 'GB18030 / GBK'],
] as const;

export function FileContentView({
  file,
  onLocalLink,
  anchor,
  highlight,
}: {
  file: FilePreviewContent;
  onLocalLink?: (path: string) => void;
  anchor?: string;
  highlight?: { offset: number; endOffset: number; requestId: string };
}) {
  const [mode, setMode] = useState<'document' | 'source'>('document');
  const [wrap, setWrap] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const highlighted = useRef<HTMLElement>(null);
  const scrolledHighlight = useRef('');
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
  useLayoutEffect(() => {
    const key = JSON.stringify([highlight?.requestId, file.page?.offset]);
    if (range && highlighted.current && scrolledHighlight.current !== key) {
      scrolledHighlight.current = key;
      highlighted.current.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
  }, [highlight?.requestId, range]);
  const markdown = file.kind === 'markdown' || /\.(?:md|markdown)$/i.test(file.path);
  return (
    <div className="file-content-view">
      {file.text !== null && (
        <div className="file-content-tools">
          {markdown && (
            <div className="file-content-tabs" role="group" aria-label="文件显示方式">
              <button type="button" aria-pressed={mode === 'document'} onClick={() => setMode('document')}>
                文档
              </button>
              <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
                源码
              </button>
            </div>
          )}
          {(!markdown || mode === 'source') && (
            <label className="file-wrap-control">
              <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
              自动换行
            </label>
          )}
          {file.encoding && (
            <span className="file-content-encoding">
              {file.encoding.toUpperCase()}
              {file.encodingSource === 'bom' ? ' · BOM' : ''}
            </span>
          )}
        </div>
      )}
      {markdown && mode === 'document' && !highlight && file.text !== null ? (
        <>
          {file.page?.paged && (
            <p className="file-fragment-note">大文档按片段显示。跨片段的代码块、表格或引用可切换源码查看。</p>
          )}
          <div className="file-document-scroll" key={file.page?.offset || 0}>
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
        <pre key={file.page?.offset || 0} className={'file-source-scroll' + (wrap ? ' wrapped' : '')}>
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
