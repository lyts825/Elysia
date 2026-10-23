import { Children, isValidElement, memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : '',
    )
    .join('');
}

// Resolve within a document's project scope, including URL-encoded paths. Never hand
// an absolute filesystem path or a traversal outside that scope to a preview API.
export function markdownLocalPath(href: string, sourcePath = ''): string | null {
  if (!href || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) return null;
  const hashAt = href.indexOf('#');
  const fragment = hashAt < 0 ? '' : href.slice(hashAt);
  let pathname = (hashAt < 0 ? href : href.slice(0, hashAt)).split('?')[0];
  try {
    pathname = decodeURIComponent(pathname).replace(/\\/g, '/');
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(pathname) || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(pathname)) return null;
  const parts = pathname.startsWith('/') ? [] : sourcePath.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/') + fragment;
}

function localImageUrl(src: string, sourcePath: string, resourceBase?: string | null) {
  if (!resourceBase || !markdownLocalPath(src, sourcePath)) return null;
  const scope = /^(?:\/terminal)?(\/preview\/[^/]+\/|\/api\/projects\/[^/]+\/resources\/)/.exec(
    resourceBase,
  )?.[0];
  if (!scope) return null;
  const path = markdownLocalPath(src, sourcePath)!.split('#')[0];
  return scope + path.split('/').map(encodeURIComponent).join('/');
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const code = Children.toArray(children).find(isValidElement);
  const language = isValidElement<{ className?: string }>(code)
    ? /language-([^\s]+)/.exec(code.props.className || '')?.[1]
    : '';
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span>{language || '代码'}</span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(plainText(children).replace(/\n$/, ''));
              setCopied(true);
              setFailed(false);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
              if (timer.current) clearTimeout(timer.current);
              setFailed(true);
            }
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {failed && (
        <p className="markdown-code-feedback" role="alert">
          复制失败，可选中文字手动复制。
        </p>
      )}
      {copied && (
        <p className="markdown-code-feedback" role="status">
          已复制代码。
        </p>
      )}
      <pre role="region" aria-label={language ? `代码块 · ${language}` : '代码块'}>
        {children}
      </pre>
    </div>
  );
}

function DocumentImage({
  src,
  alt,
  title,
  sourcePath,
  resourceBase,
}: {
  src?: string;
  alt?: string;
  title?: string;
  sourcePath: string;
  resourceBase?: string | null;
}) {
  const url = src ? localImageUrl(src, sourcePath, resourceBase) : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url)
    return (
      <span className="markdown-image-placeholder" title={title || src}>
        {alt || '图片'} · {url ? '图片无法读取' : '图片链接'}
      </span>
    );
  return (
    <img
      src={url}
      alt={alt || ''}
      title={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailedUrl(url)}
    />
  );
}

export const MarkdownDocument = memo(function MarkdownDocument({
  text,
  sourcePath = '',
  resourceBase,
  onLocalLink,
  anchor,
  anchorRequestId,
  anchorHeadingLine,
  onAnchorMissing,
  className = '',
}: {
  text: string;
  sourcePath?: string;
  resourceBase?: string | null;
  onLocalLink?: (path: string) => void;
  anchor?: string;
  anchorRequestId?: string;
  anchorHeadingLine?: number;
  onAnchorMissing?: (anchor: string) => void;
  className?: string;
}) {
  const prefix = 'md-' + useId().replace(/[^\w-]/g, '') + '-';
  const root = useRef<HTMLElement>(null);
  const scrolledAnchor = useRef('');
  const scrollToAnchor = (value: string) => {
    const raw = value.replace(/^#/, '');
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return false;
    }
    for (const id of [prefix + raw, prefix + decoded, raw, decoded]) {
      const target = document.getElementById(id);
      if (target && root.current?.contains(target)) {
        target.scrollIntoView({ block: 'start', behavior: 'instant' });
        return true;
      }
    }
    return false;
  };
  useEffect(() => {
    const key = JSON.stringify([sourcePath, anchor, anchorRequestId]);
    if (anchor && scrolledAnchor.current !== key) {
      if (scrollToAnchor(anchor)) scrolledAnchor.current = key;
      else onAnchorMissing?.(anchor);
    }
  }, [anchor, anchorRequestId, text, sourcePath, prefix, onAnchorMissing]);
  const headings = new Map<string, number>();
  const heading = (
    level: 1 | 2 | 3 | 4 | 5 | 6,
    children: ReactNode,
    suppliedId?: string,
    className?: string,
    line?: number,
  ) => {
    const slug = plainText(children)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = headings.get(slug) || 0;
    headings.set(slug, count + 1);
    const id =
      prefix +
      (anchor && anchorHeadingLine !== undefined && anchorHeadingLine === line
        ? anchor.replace(/^#/, '')
        : slug + (count ? '-' + count : ''));
    const Tag = `h${level}` as 'h1';
    return (
      <Tag id={suppliedId || id} className={className}>
        {children}
      </Tag>
    );
  };
  return (
    <article ref={root} className={'markdown-document ' + className}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ footnoteLabel: '注释', footnoteBackLabel: '返回正文', clobberPrefix: prefix }}
        components={{
          h1: ({ children, id, className, node }) =>
            heading(1, children, id, className, node?.position?.start.line),
          h2: ({ children, id, className, node }) =>
            heading(2, children, id, className, node?.position?.start.line),
          h3: ({ children, id, className, node }) =>
            heading(3, children, id, className, node?.position?.start.line),
          h4: ({ children, id, className, node }) =>
            heading(4, children, id, className, node?.position?.start.line),
          h5: ({ children, id, className, node }) =>
            heading(5, children, id, className, node?.position?.start.line),
          h6: ({ children, id, className, node }) =>
            heading(6, children, id, className, node?.position?.start.line),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="markdown-table-scroll" role="region" aria-label="文档表格" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          img: ({ src, alt, title }) => (
            <DocumentImage
              src={src}
              alt={alt}
              title={title}
              sourcePath={sourcePath}
              resourceBase={resourceBase}
            />
          ),
          a: ({ href, children, node: _node, ...props }) => {
            if (!href) return <span>{children}</span>;
            if (href.startsWith('#'))
              return (
                <a
                  {...props}
                  href={href}
                  title={props.title}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!scrollToAnchor(href)) {
                      if (onLocalLink && sourcePath) onLocalLink(sourcePath + href);
                      else onAnchorMissing?.(href);
                    }
                  }}
                >
                  {children}
                </a>
              );
            if (/^(?:https?:|mailto:)/i.test(href))
              return (
                <a
                  {...props}
                  href={href}
                  title={props.title || href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={plainText(children) ? `${plainText(children)}（在新窗口打开）` : undefined}
                >
                  {children}
                </a>
              );
            const local = markdownLocalPath(href, sourcePath);
            return local && onLocalLink ? (
              <a
                {...props}
                href={href}
                title={props.title || href}
                onClick={(event) => {
                  event.preventDefault();
                  onLocalLink(local);
                }}
              >
                {children}
              </a>
            ) : (
              <span className="markdown-unavailable-link" title={props.title || href}>
                {children}
              </span>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </article>
  );
});
