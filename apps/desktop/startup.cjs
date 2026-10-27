// 校验并保存启动页配置及媒体资源。
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MEDIA_LIMIT = 4 * 1024 * 1024;
const DEFAULT_STARTUP = Object.freeze({
  version: 2,
  enabled: true,
  style: 'bloom',
  title: 'Elysia',
  caption: '把想法，慢慢做成喜欢的日常。',
  accent: '#8c4d64',
  background: '#faf8f9',
});
const types = { gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const extensionFor = (mime) => Object.keys(types).find((extension) => types[extension] === mime);
const cleanName = (name) =>
  path
    .basename(name)
    .replace(/[\x00-\x1f]/g, '')
    .slice(0, 120);

function verifyMedia(bytes, mime) {
  if (!bytes.length || bytes.length > MEDIA_LIMIT) throw new Error('动画文件须小于或等于 4 MiB');
  const valid =
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) ||
    (mime === 'video/mp4' && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') ||
    (mime === 'video/webm' &&
      bytes.length >= 4 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  if (!valid) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
}
function normalizeMedia(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 120 ||
    !Object.values(types).includes(value.mime) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MEDIA_LIMIT
  )
    throw new Error('动画文件信息无效');
  return { id: value.id, name: cleanName(value.name), mime: value.mime, size: value.size };
}
function normalizeStartup(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 2 ||
    typeof value.enabled !== 'boolean' ||
    !['bloom', 'orbit', 'minimal', 'media'].includes(value.style) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 64 ||
    typeof value.caption !== 'string' ||
    value.caption.length > 100 ||
    typeof value.accent !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(value.accent) ||
    typeof value.background !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(value.background)
  )
    throw new Error('启动偏好无效');
  const config = {
    version: 2,
    enabled: value.enabled,
    style: value.style,
    title: value.title.trim(),
    caption: value.caption.trim(),
    accent: value.accent.toLowerCase(),
    background: value.background.toLowerCase(),
  };
  if (value.media !== undefined) config.media = normalizeMedia(value.media);
  if (config.style === 'media' && !config.media) throw new Error('请先导入动画文件');
  return config;
}
function decodeUpload(value) {
  const media = normalizeMedia(value?.media);
  if (typeof value.dataUrl !== 'string' || value.dataUrl.length > Math.ceil(MEDIA_LIMIT / 3) * 4 + 64)
    throw new Error('动画文件无效');
  const prefix = `data:${media.mime};base64,`;
  if (!value.dataUrl.startsWith(prefix)) throw new Error('动画必须是本地导入文件');
  const encoded = value.dataUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('动画编码无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.toString('base64') !== encoded ||
    bytes.length !== media.size ||
    createHash('sha256').update(bytes).digest('hex') !== media.id
  )
    throw new Error('动画文件摘要不匹配');
  verifyMedia(bytes, media.mime);
  return { media, bytes };
}
function uploadFromBytes(name, mime, bytes) {
  verifyMedia(bytes, mime);
  return {
    media: {
      id: createHash('sha256').update(bytes).digest('hex'),
      name: cleanName(name),
      mime,
      size: bytes.length,
    },
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  };
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
async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('启动偏好目录无效');
}
function createStartupStore(directory) {
  const parent = path.join(directory, 'desktop'),
    file = path.join(parent, 'startup-v2.json'),
    assets = path.join(parent, 'startup-media');
  let reading,
    writing = Promise.resolve(),
    issue = '';
  const mediaCache = new Map();
  const assetPath = (media) => path.join(assets, media.id + '.' + extensionFor(media.mime));
  async function persist(config, upload) {
    await safeDirectory(parent);
    let created;
    if (upload) {
      const decoded = decodeUpload(upload);
      if (
        !config.media ||
        decoded.media.id !== config.media.id ||
        decoded.media.mime !== config.media.mime ||
        decoded.media.size !== config.media.size
      )
        throw new Error('动画文件信息已改变');
      await safeDirectory(assets);
      try {
        await fs.writeFile(assetPath(config.media), decoded.bytes, { flag: 'wx', mode: 0o600 });
        created = assetPath(config.media);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const present = await readBounded(assetPath(config.media), MEDIA_LIMIT);
        if (createHash('sha256').update(present).digest('hex') !== config.media.id)
          throw new Error('已保存动画文件摘要不匹配');
      }
    }
    const temporary = path.join(parent, `startup-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } catch (error) {
      if (created) await fs.unlink(created).catch(() => {});
      throw error;
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return config;
  }
  async function load() {
    try {
      return normalizeStartup(JSON.parse((await readBounded(file, 8192)).toString('utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        issue = '无法读取已保存的启动偏好，当前使用默认外观。';
        return { ...DEFAULT_STARTUP };
      }
    }
    try {
      const legacy = JSON.parse(
        (await readBounded(path.join(parent, 'startup.json'), 6 * 1024 * 1024)).toString('utf8'),
      );
      if (legacy.version !== 1) throw new Error('旧偏好版本无效');
      let upload;
      if (legacy.media) {
        if (typeof legacy.media.dataUrl !== 'string' || !Object.values(types).includes(legacy.media.mime))
          throw new Error('旧动画文件无效');
        const prefix = `data:${legacy.media.mime};base64,`;
        if (!legacy.media.dataUrl.startsWith(prefix)) throw new Error('旧动画来源无效');
        const encoded = legacy.media.dataUrl.slice(prefix.length);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('旧动画编码无效');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new Error('旧动画编码无效');
        upload = uploadFromBytes(legacy.media.name, legacy.media.mime, bytes);
      }
      return await persist(normalizeStartup({ ...legacy, version: 2, media: upload?.media }), upload);
    } catch (error) {
      if (error.code !== 'ENOENT') issue = '无法迁移旧启动偏好，原文件已保留，当前使用默认外观。';
      return { ...DEFAULT_STARTUP };
    }
  }
  const read = () => (reading ||= load());
  return {
    read,
    get issue() {
      return issue;
    },
    write(value, upload) {
      const config = normalizeStartup(value);
      const job = writing
        .catch(() => {})
        .then(async () => {
          const prior = await read();
          if (
            config.media &&
            !upload &&
            (!prior.media ||
              config.media.id !== prior.media.id ||
              config.media.mime !== prior.media.mime ||
              config.media.size !== prior.media.size)
          )
            throw new Error('请重新导入动画文件');
          const saved = await persist(config, upload);
          reading = Promise.resolve(saved);
          issue = '';
          if (prior.media?.id !== saved.media?.id) {
            mediaCache.clear();
            if (prior.media) {
              try {
                const old = assetPath(prior.media),
                  stat = await fs.lstat(old);
                if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(old);
              } catch {}
            }
          }
          return saved;
        });
      writing = job;
      return job;
    },
    async readMedia(value) {
      const media = normalizeMedia(value),
        config = await read();
      if (
        !config.media ||
        config.media.id !== media.id ||
        config.media.mime !== media.mime ||
        config.media.size !== media.size
      )
        throw new Error('动画偏好已改变，请重新读取');
      if (mediaCache.has(media.id)) return mediaCache.get(media.id);
      mediaCache.clear();
      const job = (async () => {
        const stat = await fs.lstat(assets);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('动画文件目录无效');
        const bytes = await readBounded(assetPath(media), MEDIA_LIMIT);
        if (bytes.length !== media.size || createHash('sha256').update(bytes).digest('hex') !== media.id)
          throw new Error('已保存动画文件摘要不匹配');
        verifyMedia(bytes, media.mime);
        return `data:${media.mime};base64,${bytes.toString('base64')}`;
      })().catch((error) => {
        if (mediaCache.get(media.id) === job) mediaCache.delete(media.id);
        throw error;
      });
      mediaCache.set(media.id, job);
      return job;
    },
    async import(filePath) {
      const extension = path.extname(filePath).slice(1).toLowerCase(),
        mime = types[extension];
      if (!mime) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
      try {
        return uploadFromBytes(path.basename(filePath), mime, await readBounded(filePath, MEDIA_LIMIT));
      } catch {
        throw new Error('请选择不超过 4 MiB 的有效本地 GIF、MP4 或 WebM 动画');
      }
    },
  };
}
module.exports = {
  createStartupStore,
  normalizeStartup,
  normalizeMedia,
  decodeUpload,
  uploadFromBytes,
  DEFAULT_STARTUP,
  MEDIA_LIMIT,
  readBounded,
};
