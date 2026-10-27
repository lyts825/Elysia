/**
 * 渲染 Markdown 文档并处理本地链接。
 * 以受控Markdown渲染器处理标题、表格、代码和本地资源，隔离文档锚点；外部链接与项目内定位走不同导航路径。
 * EN: Renders Markdown documents and resolves local links. Renders headings, tables, code, and local resources through controlled Markdown components with document-scoped anchors; external links and project-local navigation use distinct paths.
 */
import { Children, isValidElement, memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

/**
 * 递归抽取 React 子节点中的文字，用于标题锚点和代码复制，忽略非文本节点属性。
 * EN: Extract text recursively from React children for anchors and copying, ignoring non-text node attributes.
 */
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

/**
 * 在文档项目范围内解析路径，包括 URL 编码形式，不应将
 * EN: Resolve within a document's project scope, including URL-encoded paths. Never hand
 */
/**
 * 绝对文件系统路径或越界路径交给预览 API。
 * EN: an absolute filesystem path or a traversal outside that scope to a preview API.
 */
export function markdownLocalPath(href: string, sourcePath = ''): string | null {
  /**
   * 对解码后的路径再次检查协议与控制字符，逐段处理 .. 并拒绝越出项目范围。
   * EN: Recheck protocols/control characters after decoding; resolve .. by segment and reject project-scope escape.
   */
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

/**
 * 将文档相对图片解析为允许的本地预览或项目资源URL；拒绝未认可的资源根与无效路径，并逐段编码。
 * EN: Resolves a document-relative image to an allowed local preview or project-resource URL, rejecting unsupported roots and invalid paths while encoding each path segment.
 */
function localImageUrl(src: string, sourcePath: string, resourceBase?: string | null) {
  /**
   * 图片只允许映射到受支持的本地预览或项目资源路由，并逐段编码路径。
   * EN: Images map only to supported local previews or project-resource routes; encode path segments separately.
   */
  if (!resourceBase || !markdownLocalPath(src, sourcePath)) return null;
  const scope = /^(?:\/terminal)?(\/preview\/[^/]+\/|\/api\/projects\/[^/]+\/resources\/)/.exec(
    resourceBase,
  )?.[0];
  if (!scope) return null;
  const path = markdownLocalPath(src, sourcePath)!.split('#')[0];
  return scope + path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 代码块保留原内容并提供复制反馈；反馈定时器在卸载时清理，剪贴板失败不影响正文。
 * EN: Preserve code text and copy feedback; clear feedback timers on unmount. Clipboard failure leaves the document usable.
 */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 文档图片组件卸载时清除延迟处理计时器，避免已移除图片继续发布状态。
   * EN: Clears the delayed-processing timer when the document image unmounts so a removed image cannot continue updating state.
   */
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

/**
 * Markdown 图片仅映射到当前本地资源范围；外部或越界图片显示占位而不发起加载。
 * EN: Map images only within the current local resource scope; external/escaping images become placeholders without loading.
 */
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

/**
 * 渲染 GFM 文档但跳过原始 HTML，重写标题、代码块、表格、图片和链接的交互。
 * 每个实例使用独立标题前缀，重名标题附加序号；文件锚点只在本实例根节点内定位，
 * 分页定位可用服务端标题行号固定目标，缺失目标交给调用方提示或切换源码。
 * EN: Render GFM without raw HTML, customizing headings/code/tables/images/links. Prefix headings per instance and suffix duplicates. Locate anchors only inside this root; server line metadata stabilizes paging, while missing targets are reported or handled as source.
 */
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
  /**
   * 同时尝试编码和解码的锚点形式，但必须验证目标属于当前 Markdown 根节点。
   * EN: Try encoded and decoded anchors, but require the target to belong to this Markdown root.
   */
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
  /**
   * 按文档路径、锚点和定位请求建立一次性滚动身份；正文更新后重试尚未定位目标，失败通知上层，已成功目标不重复滚动。
   * EN: Keys one-shot scrolling by document path, anchor, and request; text updates retry unresolved targets and notify the parent on failure without scrolling successful targets repeatedly.
   */
  useEffect(() => {
    const key = JSON.stringify([sourcePath, anchor, anchorRequestId]);
    if (anchor && scrolledAnchor.current !== key) {
      if (scrollToAnchor(anchor)) scrolledAnchor.current = key;
      else onAnchorMissing?.(anchor);
    }
  }, [anchor, anchorRequestId, text, sourcePath, prefix, onAnchorMissing]);
  const headings = new Map<string, number>();
  /**
   * 生成带文档前缀和去重后缀的标题锚点；按源码行匹配定位请求，使跨页标题跳转仍使用服务端定位的锚点。
   * EN: Generates heading anchors with a document prefix and duplicate suffixes. Matching the source line of a location request preserves the server-located anchor across paged content.
   */
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
          /**
           * 把Markdown的1级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-1 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h1: ({ children, id, className, node }) =>
            heading(1, children, id, className, node?.position?.start.line),
          /**
           * 把Markdown的2级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-2 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h2: ({ children, id, className, node }) =>
            heading(2, children, id, className, node?.position?.start.line),
          /**
           * 把Markdown的3级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-3 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h3: ({ children, id, className, node }) =>
            heading(3, children, id, className, node?.position?.start.line),
          /**
           * 把Markdown的4级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-4 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h4: ({ children, id, className, node }) =>
            heading(4, children, id, className, node?.position?.start.line),
          /**
           * 把Markdown的5级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-5 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h5: ({ children, id, className, node }) =>
            heading(5, children, id, className, node?.position?.start.line),
          /**
           * 把Markdown的6级标题交给统一标题渲染器，保留原ID、样式及源码行以建立可定位锚点。
           * EN: Routes a level-6 Markdown heading through the shared renderer, preserving supplied ID, styling, and source line for addressable anchors.
           */
          h6: ({ children, id, className, node }) =>
            heading(6, children, id, className, node?.position?.start.line),
          /**
           * 将代码块交给CodeBlock包装器，统一处理原始代码展示和复制交互。
           * EN: Delegates fenced code to CodeBlock for consistent source display and copy interaction.
           */
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          /**
           * 为Markdown表格提供可聚焦的横向滚动区域，防止宽表挤压正文布局。
           * EN: Wraps Markdown tables in a focusable horizontal scroll region so wide tables do not expand the document layout.
           */
          table: ({ children }) => (
            <div className="markdown-table-scroll" role="region" aria-label="文档表格" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          /**
           * 把图片源和当前文档位置交给受控图片组件，由它校验本地资源并处理不可用状态。
           * EN: Passes the image source and current document location to the controlled image component, which validates local resources and handles unavailable images.
           */
          img: ({ src, alt, title }) => (
            <DocumentImage
              src={src}
              alt={alt}
              title={title}
              sourcePath={sourcePath}
              resourceBase={resourceBase}
            />
          ),
          /**
           * 按目标类型分派链接：页内锚点优先本地滚动，网页在隔离的新窗口打开，本地文件交给上层定位；不可解析目标保留为文本。
           * EN: Dispatches links by target: local scrolling for fragments, isolated new windows for web links, and parent navigation for local files. Unresolvable targets remain readable text.
           */
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
