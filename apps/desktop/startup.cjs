const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MEDIA_LIMIT = 4 * 1024 * 1024;
const CONFIG_LIMIT = 6 * 1024 * 1024;
const DEFAULT_STARTUP = Object.freeze({
  version: 1,
  enabled: true,
  style: 'bloom',
  title: 'Elysia',
  caption: '把想法，慢慢做成喜欢的日常。',
  accent: '#bd8c96',
  background: '#f8faf5',
});
const types = { gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };

function verifyMedia(bytes, mime) {
  if (!bytes.length || bytes.length > MEDIA_LIMIT) throw new Error('动画文件须小于或等于 4 MiB');
  const valid =
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) ||
    (mime === 'video/mp4' && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') ||
    (mime === 'video/webm' &&
      bytes.length >= 4 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  if (!valid) throw new Error('仅支持有效的 GIF、MP4 或 WebM 动画');
}

function normalizeStartup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('启动偏好无效');
  if (
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !['bloom', 'orbit', 'minimal', 'media'].includes(value.style) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 64 ||
    typeof value.caption !== 'string' ||
    value.caption.length > 100 ||
    !/^#[0-9a-f]{6}$/i.test(value.accent) ||
    !/^#[0-9a-f]{6}$/i.test(value.background)
  )
    throw new Error('启动偏好无效');
  const config = {
    version: 1,
    enabled: value.enabled,
    style: value.style,
    title: value.title.trim(),
    caption: value.caption.trim(),
    accent: value.accent.toLowerCase(),
    background: value.background.toLowerCase(),
  };
  if (value.media !== undefined) {
    const media = value.media;
    if (
      !media ||
      typeof media !== 'object' ||
      typeof media.name !== 'string' ||
      media.name.length > 120 ||
      !Object.values(types).includes(media.mime) ||
      typeof media.dataUrl !== 'string' ||
      media.dataUrl.length > Math.ceil(MEDIA_LIMIT / 3) * 4 + 64
    )
      throw new Error('动画文件无效');
    const prefix = `data:${media.mime};base64,`;
    if (!media.dataUrl.startsWith(prefix)) throw new Error('动画必须是本地导入文件');
    const encoded = media.dataUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('动画编码无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('动画编码无效');
    verifyMedia(bytes, media.mime);
    config.media = {
      name: path
        .basename(media.name)
        .replace(/[\x00-\x1f]/g, '')
        .slice(0, 120),
      mime: media.mime,
      dataUrl: media.dataUrl,
    };
  }
  if (config.style === 'media' && !config.media) throw new Error('请先导入动画文件');
  return config;
}

async function readBounded(file, limit) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error('文件大小或类型无效');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('文件大小或类型无效');
    const chunks = [];
    let count = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - count + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > limit) throw new Error('文件超过大小限制');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, count);
  } finally {
    await handle.close();
  }
}

function createStartupStore(directory) {
  const parent = path.join(directory, 'desktop');
  const file = path.join(parent, 'startup.json');
  let writing = Promise.resolve();
  return {
    async read() {
      try {
        return normalizeStartup(JSON.parse((await readBounded(file, CONFIG_LIMIT)).toString('utf8')));
      } catch {
        return { ...DEFAULT_STARTUP };
      }
    },
    write(value) {
      const config = normalizeStartup(value);
      const job = writing
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(parent, { recursive: true });
          const directoryStat = await fs.lstat(parent);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error('启动偏好目录无效');
          const temporary = path.join(parent, `startup-${randomUUID()}.tmp`);
          try {
            await fs.writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
          } finally {
            await fs.unlink(temporary).catch(() => {});
          }
          return config;
        });
      writing = job;
      return job;
    },
    async import(filePath) {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MEDIA_LIMIT)
        throw new Error('请选择不超过 4 MiB 的本地动画文件');
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const mime = types[extension];
      if (!mime) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
      const bytes = await readBounded(filePath, MEDIA_LIMIT);
      verifyMedia(bytes, mime);
      return {
        name: path.basename(filePath).slice(0, 120),
        mime,
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      };
    },
  };
}
module.exports = { createStartupStore, normalizeStartup, DEFAULT_STARTUP, MEDIA_LIMIT };
