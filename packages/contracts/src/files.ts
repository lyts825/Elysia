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

export function isBinaryFile(name: string, content: Uint8Array) {
  return (
    content.includes(0) ||
    /^(?:docx?|xlsx?|pptx?|pdf|zip|png|jpe?g|webp|gif|ico|woff2?|mp[34])$/.test(extension(name))
  );
}

export function fileMediaType(name: string, content?: Uint8Array) {
  return (
    media[extension(name)] ||
    (content && isBinaryFile(name, content) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
  );
}
