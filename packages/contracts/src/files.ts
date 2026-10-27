// 文本文件编码、分页与文件读取相关的数据契约。
export const textFileEncodings = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const;
export type TextFileEncoding = (typeof textFileEncodings)[number];
export type ResolvedTextEncoding = Exclude<TextFileEncoding, 'auto'>;
// 分页同时记录请求偏移、实际字节范围和文件版本；nextOffset 为 null 表示结束。
export type TextFilePage = {
  requestedOffset: number;
  offset: number;
  endOffset: number;
  nextOffset: number | null;
  totalBytes: number;
  version: string;
  paged: boolean;
};
export type TextPageOptions = {
  offset?: number;
  limit?: number;
  version?: string;
  signal?: AbortSignal;
};
export const TEXT_PAGE_BYTES = 256 * 1024;
export const LEGACY_TEXT_BYTES = 1024 * 1024;

const media: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

const extension = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() || '';

/** 用 NUL 字节或已知二进制扩展名判断展示方式；这是预览策略，不是完整文件格式验证。 */
export function isBinaryFile(name: string, content: Uint8Array) {
  return (
    content.includes(0) ||
    /^(?:docx?|xlsx?|pptx?|pdf|zip|png|jpe?g|webp|gif|ico|woff2?|mp[34])$/.test(extension(name))
  );
}

/** 优先使用已知扩展名的媒体类型；未知类型按二进制判定回退到 octet-stream 或 UTF-8 文本。 */
export function fileMediaType(name: string, content?: Uint8Array) {
  return (
    media[extension(name)] ||
    (content && isBinaryFile(name, content) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
  );
}
