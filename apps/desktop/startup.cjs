/**
 * 校验并保存启动页配置及媒体资源。
 * EN: Validate and persist startup preferences and their media resources.
 *
 * 统一处理启动偏好的读取、校验和媒体导入；媒体路径及体积检查在桌面端完成，页面只使用通过检查的配置结果。
 * EN: Centralize preference reads, validation, and media import; desktop-side path and size checks produce the configuration used by the page.
 */
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
/**
 * 将允许的MIME类型映射为固定媒体扩展名，不接受任意路径后缀。
 * EN: Map allowed MIME types to fixed media extensions rather than arbitrary path suffixes.
 */
const extensionFor = (mime) => Object.keys(types).find((extension) => types[extension] === mime);
/**
 * 取文件基名并移除控制字符，限制显示名称长度。
 * EN: Keep the basename, remove control characters, and bound display-name length.
 */
const cleanName = (name) =>
  path
    .basename(name)
    .replace(/[\x00-\x1f]/g, '')
    .slice(0, 120);

/**
 * 检查媒体大小及 GIF、MP4 或 WebM 的文件头，不仅依赖文件扩展名。
 * EN: Check media size and GIF, MP4, or WebM signatures instead of relying only on the extension.
 */
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
/**
 * 校验媒体元数据，并移除文件名中的目录和控制字符。
 * EN: Validate media metadata and remove directory components and control characters from its
 * display name.
 */
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
/**
 * 验证启动配置版本、文字长度、颜色和媒体引用，返回规范化后的配置。
 * EN: Validate startup configuration version, text lengths, colors, and media references, returning
 * normalized configuration.
 */
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
/**
 * 解码本地导入的 data URL，并核对规范 Base64、长度、摘要和媒体文件头。
 * EN: Decode a locally imported data URL and verify canonical Base64, declared size, digest, and
 * media signature.
 */
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
/**
 * 校验媒体字节后计算摘要，返回待上传元数据与data URL。
 * EN: Validate media bytes, compute their digest, and return upload metadata plus a data URL.
 */
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
/**
 * 读取普通文件时限制实际读取字节数；拒绝符号链接和超过上限的内容。
 * EN: Bound the bytes actually read from an ordinary file; reject symbolic links and oversized
 * content.
 */
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
/**
 * 创建并核对真实偏好目录，拒绝符号链接或特殊文件。
 * EN: Create and validate the real preference directory, rejecting symbolic links and special entries.
 */
async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('启动偏好目录无效');
}
/**
 * 管理桌面启动偏好及按摘要保存的媒体。读取会缓存结果，写入通过队列串行化，
 * 供启动窗口和工作台在同一数据目录中共享配置。
 * EN: Manage desktop startup preferences and digest-addressed media. Cache reads and serialize
 * writes so the startup window and workbench can share configuration in one data directory.
 */
function createStartupStore(directory) {
  const parent = path.join(directory, 'desktop'),
    file = path.join(parent, 'startup-v2.json'),
    assets = path.join(parent, 'startup-media');
  let reading,
    writing = Promise.resolve(),
    issue = '';
  const mediaCache = new Map();
  /**
   * 仅由已验证摘要与MIME生成资产路径，避免把显示名称作为存储路径。
   * EN: Derive asset paths from validated digest/MIME rather than the untrusted display name.
   */
  const assetPath = (media) => path.join(assets, media.id + '.' + extensionFor(media.mime));
  /**
   * 先验证并保存上传媒体，再以临时文件替换配置。已存在的同摘要媒体必须重新核验，
   * 配置保存失败时只删除本次新建的媒体，不能删除其他调用已经保存的对象。
   * EN: Validate and save uploaded media before replacing the configuration via a temporary file.
   * Recheck existing media with the same digest. If configuration persistence fails, remove only media
   * created by this attempt, never objects saved by another call.
   */
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
  /**
   * 优先读取新版小配置；只有新版文件不存在才尝试迁移旧内联媒体配置。
   * 损坏配置不覆盖原文件，返回默认外观并保留 issue，供界面提示用户重新保存。
   * EN: Prefer the small current-format configuration; migrate legacy inline media only when the
   * current file is absent. Preserve corrupt files, return default visuals, and retain an issue
   * message for the settings UI.
   */
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
  /**
   * 复用一次配置加载Promise，使启动页和设置页共享同一读取结果。
   * EN: Reuse one configuration-load promise so startup and settings share the same read.
   */
  const read = () => (reading ||= load());
  return {
    read,
    /**
     * 公开最近一次读取或迁移问题，供界面提示；读取不修改该问题。
     * EN: Expose the latest read/migration issue for UI feedback without changing it.
     */
    get issue() {
      return issue;
    },
    /**
     * 串行写偏好，避免并发保存删除彼此仍引用的媒体。未带上传内容时只能复用当前媒体，
     * 新配置落盘后更新读取缓存，再尽力清理已不引用的旧媒体。
     * EN: Serialize preference writes so concurrent saves cannot delete media another save still
     * references. Without an upload, reuse only the current media. After persistence, refresh the read
     * cache and attempt to remove unreferenced old media.
     */
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
    /**
     * 只读取当前配置仍引用的媒体，核对类型、大小和 SHA-256 后返回本地 data URL。
     * 相同摘要共享在途读取；失败会移除对应缓存，之后可重新核验读取。
     * EN: Read only media still referenced by current preferences, checking type, size, and SHA-256
     * before returning a local data URL. Share in-flight reads by digest and evict failed entries so
     * later calls can retry verification.
     */
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
    /**
     * 将用户选中的本地媒体转为待上传结构；这里只读文件，不自动保存启动偏好。
     * EN: Convert a user-selected local media file into an upload structure. This only reads the file
     * and does not save startup preferences.
     */
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
