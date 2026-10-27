/**
 * 管理启动阶段使用的本地偏好设置。
 * 统一管理浏览器与桌面启动偏好、媒体摘要和存储迁移，校验文件头、大小及解码并管理Blob URL；不接受任意远程媒体地址。
 * EN: Manages shared startup preferences and local media. Shares browser/desktop startup preferences, media digests, and migrations with signature/size/decode validation and Blob-URL lifecycle management, excluding arbitrary remote media URLs.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { markStartupStage } from './StartupDiagnostics';
import './desktop';

export type StartupMedia = {
  id: string;
  name: string;
  mime: 'image/gif' | 'video/mp4' | 'video/webm';
  size: number;
};
export type StartupMediaUpload = { media: StartupMedia; dataUrl?: string; blob?: Blob };
export type StartupPreferences = {
  version: 2;
  enabled: boolean;
  style: 'bloom' | 'orbit' | 'minimal' | 'media';
  title: string;
  caption: string;
  accent: string;
  background: string;
  media?: StartupMedia;
};
export const defaultStartupPreferences: StartupPreferences = {
  version: 2,
  enabled: true,
  style: 'bloom',
  title: 'Elysia',
  caption: '把想法，慢慢做成喜欢的日常。',
  accent: '#8c4d64',
  background: '#faf8f9',
};
export const startupMediaLimit = 4 * 1024 * 1024;
const storageKey = 'elysia:startup:v2',
  legacyStorageKey = 'elysia:startup:v1';
const mediaTypes = ['image/gif', 'video/mp4', 'video/webm'] as const;

/**
 * 校验启动媒体摘要ID、名称、MIME和大小，返回受控元数据；不合法输入抛错，不能直接信任缓存对象。
 * EN: Validates startup-media digest ID, name, MIME, and size and returns controlled metadata; invalid input throws rather than trusting a cached object.
 */
export function normalizeStartupMedia(value: unknown): StartupMedia {
  /**
   * 限制媒体标识、名称、类型和大小，避免将不可信的缓存直接用于启动页。
   * EN: Validate media ID/name/type/size before trusting startup-cache data.
   */
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('动画文件信息无效');
  const media = value as Record<string, unknown>;
  if (
    typeof media.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(media.id) ||
    typeof media.name !== 'string' ||
    !media.name ||
    media.name.length > 120 ||
    !mediaTypes.includes(media.mime as StartupMedia['mime']) ||
    typeof media.size !== 'number' ||
    !Number.isSafeInteger(media.size) ||
    media.size < 1 ||
    media.size > startupMediaLimit
  )
    throw new Error('动画文件信息无效');
  return {
    id: media.id,
    name: media.name.replace(/[\x00-\x1f]/g, '').slice(0, 120),
    mime: media.mime as StartupMedia['mime'],
    size: media.size,
  };
}
/**
 * 严格恢复版本2偏好，限定样式、颜色和文本字段；媒体样式必须有有效元数据，错误配置抛出供上层恢复。
 * EN: Strictly restores version-2 preferences with bounded style, color, and text fields. Media style requires valid metadata, and invalid configuration throws for caller recovery.
 */
export function normalizeStartupPreferences(value: unknown): StartupPreferences {
  /**
   * 接受版本 2 及有限的样式和颜色格式；媒体样式必须同时提供有效媒体信息。
   * EN: Accept version two and limited style/color formats; media style requires valid media metadata.
   */
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('启动偏好无效');
  const v = value as Record<string, unknown>;
  if (
    v.version !== 2 ||
    typeof v.enabled !== 'boolean' ||
    !['bloom', 'orbit', 'minimal', 'media'].includes(v.style as string) ||
    typeof v.title !== 'string' ||
    !v.title.trim() ||
    v.title.length > 64 ||
    typeof v.caption !== 'string' ||
    v.caption.length > 100 ||
    typeof v.accent !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(v.accent) ||
    typeof v.background !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(v.background)
  )
    throw new Error('启动偏好无效');
  const config: StartupPreferences = {
    version: 2,
    enabled: v.enabled,
    style: v.style as StartupPreferences['style'],
    title: v.title.trim(),
    caption: v.caption.trim(),
    accent: v.accent.toLowerCase(),
    background: v.background.toLowerCase(),
  };
  if (v.media !== undefined) config.media = normalizeStartupMedia(v.media);
  if (config.style === 'media' && !config.media) throw new Error('请先导入动画文件');
  return config;
}
/**
 * 按声明MIME核对GIF、MP4或WebM文件头并限制4MiB体积；不匹配或空文件抛错，不把元数据当作解码成功。
 * EN: Checks GIF, MP4, or WebM signatures against the declared MIME and enforces the 4 MiB limit, rejecting mismatches or empty content without treating metadata as decoding proof.
 */
function verifyBytes(bytes: Uint8Array, mime: StartupMedia['mime']) {
  /**
   * 检查文件头与声明类型是否匹配，再执行大小上限检查。
   * EN: Check actual header against declared MIME before size enforcement.
   */
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const valid =
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(text(0, 6))) ||
    (mime === 'video/mp4' && bytes.length >= 12 && text(4, 8) === 'ftyp') ||
    (mime === 'video/webm' && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value));
  if (!valid || !bytes.length || bytes.length > startupMediaLimit)
    throw new Error('仅支持不超过 4 MiB 的有效 GIF、MP4 或 WebM 动画');
}
/**
 * 对完整媒体字节计算SHA-256并返回64位十六进制字符串，供内容寻址及后续一致性检查。
 * EN: Computes SHA-256 over complete media bytes and returns a 64-character hexadecimal digest for content addressing and consistency checks.
 */
async function digest(bytes: Uint8Array) {
  /**
   * 媒体以内容摘要标识，便于后续核对资源是否一致。
   * EN: Identify media by content hash for later consistency checks.
   */
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
/**
 * 读取Blob并校验实际字节，生成摘要及清理后的文件名，再返回规范MIME的Blob与上传元数据。
 * EN: Reads and validates Blob bytes, computes their digest and sanitized filename, then returns a normalized-MIME Blob with upload metadata.
 */
async function fromBlob(name: string, mime: StartupMedia['mime'], blob: Blob): Promise<StartupMediaUpload> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  verifyBytes(bytes, mime);
  return {
    media: {
      id: await digest(bytes),
      name: name.replace(/[\x00-\x1f]/g, '').slice(0, 120),
      mime,
      size: bytes.length,
    },
    blob: new Blob([bytes], { type: mime }),
  };
}
/**
 * 把Blob或旧版base64输入统一解码并核对大小、类型及摘要；拒绝任意远程URL和不一致上传，返回可持久化Blob。
 * EN: Normalizes Blob or legacy base64 input and verifies size, type, and digest, rejecting arbitrary remote URLs and inconsistent uploads before returning a persistable Blob.
 */
async function uploadBlob(upload: StartupMediaUpload): Promise<Blob> {
  const media = normalizeStartupMedia(upload.media);
  let blob = upload.blob;
  if (!blob) {
    if (
      typeof upload.dataUrl !== 'string' ||
      upload.dataUrl.length > Math.ceil(startupMediaLimit / 3) * 4 + 64 ||
      !upload.dataUrl.startsWith(`data:${media.mime};base64,`)
    )
      throw new Error('动画必须是本地导入文件');
    const encoded = upload.dataUrl.slice(upload.dataUrl.indexOf(',') + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('动画编码无效');
    const raw = atob(encoded);
    if (btoa(raw) !== encoded) throw new Error('动画编码无效');
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    blob = new Blob([bytes], { type: media.mime });
  }
  if (blob.size !== media.size || blob.size > startupMediaLimit) throw new Error('动画大小已改变');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  verifyBytes(bytes, media.mime);
  if ((await digest(bytes)) !== media.id) throw new Error('动画文件摘要不匹配');
  return blob;
}

let database: Promise<IDBDatabase> | undefined;
/**
 * 共享浏览器媒体数据库连接；升级或失败会清除 Promise 缓存，后续操作可重新建立连接。
 * EN: Share browser media DB connection; upgrade/failure clears Promise cache so later operations reconnect.
 */
function mediaDatabase() {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('elysia-startup-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(new Error('浏览器动画存储不可用'));
    request.onblocked = () => reject(new Error('浏览器动画存储被其他窗口占用，请关闭后重试'));
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}
/**
 * 等待整个 IndexedDB 事务提交后才返回请求值，不能只用 onsuccess 宣称媒体已经保存。
 * EN: Wait for whole IndexedDB transaction commit, not request onsuccess alone, before claiming media saved.
 */
async function mediaTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await mediaDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('assets', mode),
      request = operation(transaction.objectStore('assets'));
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = transaction.onabort = () => reject(new Error('浏览器动画存储不可用或空间不足'));
  });
}
type PreferenceState = {
  config: StartupPreferences;
  loaded: boolean;
  error: string;
  desktopBootShown: boolean;
};
let state: PreferenceState = {
  config: defaultStartupPreferences,
  loaded: false,
  error: '',
  desktopBootShown: false,
};
let loadPromise: Promise<void> | undefined,
  generation = 0,
  saving = Promise.resolve<StartupPreferences | undefined>(undefined);
const listeners = new Set<() => void>();
/**
 * 替换模块级偏好状态后通知全部订阅者，使useSyncExternalStore读取到同一快照。
 * EN: Replaces module-level preference state and notifies every subscriber so useSyncExternalStore observes a consistent snapshot.
 */
function publish(next: PreferenceState) {
  state = next;
  listeners.forEach((listener) => listener());
}
/**
 * 登记偏好变化监听器并返回精确解除函数，供外部store订阅生命周期使用。
 * EN: Registers a preference listener and returns its exact unsubscribe function for the external-store lifecycle.
 */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let mediaCache: { id: string; pending: Promise<string>; url?: string } | undefined;
/**
 * 释放缓存Blob URL并清空媒体Promise缓存，供偏好变更或页面离开时避免保留旧资源。
 * EN: Revokes the cached Blob URL and clears the media-promise cache on preference changes or page exit to release obsolete resources.
 */
function clearMediaCache() {
  if (mediaCache?.url?.startsWith('blob:')) URL.revokeObjectURL(mediaCache.url);
  mediaCache = undefined;
}
window.addEventListener('pagehide', clearMediaCache);

/**
 * 读取旧版内联媒体偏好，完整校验后把媒体移入 IndexedDB，再保存 v2 元数据。
 * EN: Read legacy inline media, validate completely, move to IndexedDB, then save v2 metadata.
 */
async function migrateBrowser(): Promise<StartupPreferences> {
  const raw = localStorage.getItem(legacyStorageKey);
  if (!raw) return { ...defaultStartupPreferences };
  if (raw.length > 6 * 1024 * 1024) throw new Error('旧偏好超过大小限制');
  const old = JSON.parse(raw);
  if (old?.version !== 1) throw new Error('旧偏好版本无效');
  let upload: StartupMediaUpload | undefined;
  if (old.media) {
    const media = old.media;
    if (
      !mediaTypes.includes(media.mime) ||
      typeof media.name !== 'string' ||
      typeof media.dataUrl !== 'string' ||
      media.dataUrl.length > Math.ceil(startupMediaLimit / 3) * 4 + 64 ||
      !media.dataUrl.startsWith(`data:${media.mime};base64,`)
    )
      throw new Error('旧动画文件无效');
    const encoded = media.dataUrl.slice(media.dataUrl.indexOf(',') + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('旧动画编码无效');
    const decoded = atob(encoded);
    if (btoa(decoded) !== encoded) throw new Error('旧动画编码无效');
    upload = await fromBlob(
      media.name,
      media.mime,
      new Blob([Uint8Array.from(decoded, (character) => character.charCodeAt(0))], { type: media.mime }),
    );
  }
  const config = normalizeStartupPreferences({ ...old, version: 2, media: upload?.media });
  if (upload) await mediaTransaction('readwrite', (store) => store.put(upload!.blob!, upload!.media.id));
  localStorage.setItem(storageKey, JSON.stringify(config));
  return config;
}
/**
 * 合并并发偏好加载。桌面读取本机存储，浏览器读取 v2 或迁移旧格式；generation 防止
 * 加载结果覆盖期间已成功保存的新配置。失败显示默认外观并保留原偏好待修复。
 * EN: Coalesce concurrent loads. Desktop reads local storage; browser loads v2/migrates legacy. generation stops a late load overwriting a newer save. Failure shows defaults while preserving original preferences for repair.
 */
export function loadStartupPreferences() {
  if (loadPromise) return loadPromise;
  const current = generation;
  loadPromise = (async () => {
    try {
      let config: StartupPreferences,
        error = '',
        desktopBootShown = false;
      if (window.elysia?.readStartup) {
        const result = await window.elysia.readStartup();
        config = normalizeStartupPreferences(result.config);
        error = typeof result.issue === 'string' ? result.issue.slice(0, 160) : '';
        desktopBootShown = result.bootVisualShown === true;
      } else {
        const raw = localStorage.getItem(storageKey);
        if (raw && raw.length > 8192) throw new Error('已保存的启动偏好超过大小限制');
        config = raw ? normalizeStartupPreferences(JSON.parse(raw)) : await migrateBrowser();
      }
      if (generation === current) publish({ config, loaded: true, error, desktopBootShown });
      markStartupStage('preferences-ready', { status: error ? 'error' : 'ok' });
    } catch {
      if (generation === current)
        publish({
          config: defaultStartupPreferences,
          loaded: true,
          error: '无法读取或迁移启动偏好，原偏好已保留，当前使用默认外观。',
          desktopBootShown: false,
        });
      markStartupStage('preferences-ready', { status: 'error' });
    }
  })();
  return loadPromise;
}

/**
 * 按媒体摘要共享读取 Promise；浏览器 Blob 在创建 URL 前重新核对大小、头部和摘要。
 * 新媒体或 pagehide 会撤销旧 blob URL，防止缓存长期持有大文件。
 * EN: Share media reads by digest; recheck browser Blob size/header/hash before URLs. New media/pagehide revokes old blob URLs to avoid retaining large objects.
 */
export async function readStartupMedia(value: StartupMedia): Promise<string> {
  const media = normalizeStartupMedia(value);
  if (mediaCache?.id === media.id) return mediaCache.pending;
  clearMediaCache();
  const entry = { id: media.id } as NonNullable<typeof mediaCache>;
  entry.pending = (async () => {
    if (window.elysia?.readStartupMedia) return window.elysia.readStartupMedia(media);
    const blob = await mediaTransaction('readonly', (store) => store.get(media.id));
    if (!(blob instanceof Blob)) throw new Error('已保存的动画文件不存在，请重新导入');
    const verified = await uploadBlob({ media, blob });
    const url = URL.createObjectURL(verified);
    if (mediaCache === entry) entry.url = url;
    else URL.revokeObjectURL(url);
    return url;
  })().catch((error) => {
    if (mediaCache === entry) clearMediaCache();
    throw error;
  });
  mediaCache = entry;
  return entry.pending;
}

/**
 * 在独立图像/视频元素中实际解码，8 秒内无有效画面视为失败，并清理媒体来源及临时 URL。
 * EN: Decode using standalone image/video elements, failing without a valid frame within eight seconds and clearing sources/URLs.
 */
export async function validateStartupMedia(
  media: StartupMedia,
  upload?: StartupMediaUpload,
  signal?: AbortSignal,
) {
  let temporary: string | undefined;
  const source = upload
    ? (temporary = URL.createObjectURL(await uploadBlob(upload)))
    : await readStartupMedia(media);
  try {
    await new Promise<void>((resolve, reject) => {
      const element = media.mime === 'image/gif' ? new Image() : document.createElement('video');
      /**
       * 清除解码超时、取消监听和媒体事件，暂停视频并移除资源地址，收束成功、失败和取消三条路径。
       * EN: Clears decode timeout, abort listener, and media handlers, pauses video, and removes its source, sharing cleanup across success, failure, and cancellation.
       */
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', aborted);
        element.onload = element.onerror = null;
        if (element instanceof HTMLVideoElement) {
          element.onloadeddata = null;
          element.pause();
        }
        element.removeAttribute('src');
        if (element instanceof HTMLVideoElement) element.load();
      };
      /**
       * 先释放解码器资源，再按有无错误完成或拒绝验证Promise，统一终态处理。
       * EN: Releases decoder resources before resolving or rejecting the validation promise, centralizing terminal-state handling.
       */
      const finish = (error?: Error) => {
        cleanup();
        error ? reject(error) : resolve();
      };
      /**
       * 把调用方取消转换为明确的动画验证取消错误，并通过finish完成资源清理。
       * EN: Converts caller cancellation into an explicit media-validation cancellation error and delegates cleanup to finish.
       */
      const aborted = () => finish(new Error('动画验证已取消'));
      const timeout = window.setTimeout(
        () => finish(new Error('动画无法解码，请换用其他 GIF、MP4 或 WebM 文件')),
        8000,
      );
      element.onerror = () => finish(new Error('动画无法解码，请换用其他 GIF、MP4 或 WebM 文件'));
      if (signal?.aborted) {
        aborted();
        return;
      }
      signal?.addEventListener('abort', aborted, { once: true });
      if (element instanceof HTMLVideoElement) {
        element.muted = true;
        element.preload = 'auto';
        element.onloadeddata = () =>
          finish(
            element.videoWidth && element.videoHeight
              ? undefined
              : new Error('动画文件没有可播放的画面，请选择其他视频'),
          );
      } else
        element.onload = () =>
          finish(
            element.naturalWidth && element.naturalHeight
              ? undefined
              : new Error('动画文件没有可显示的画面，请选择其他图片'),
          );
      element.src = source;
    });
  } finally {
    if (temporary) URL.revokeObjectURL(temporary);
  }
}

/**
 * 串行保存经过规范化的偏好，动画启用时先确认可解码。
 * 浏览器先写媒体再写配置，配置失败只回滚本次新建媒体；提交成功后才发布外部状态并清理旧媒体。
 * 桌面分支通过受限桥发送配置及校验后的 data URL，原始文件不由页面直接写本机目录。
 * EN: Serialize normalized saves and verify enabled animation decoding first. Browser writes media before metadata, rolling back newly created media only on config failure. Publish state/clean old media after commit. Desktop sends validated config/data URL through restricted bridge, not arbitrary filesystem writes.
 */
export function saveStartupPreferences(value: StartupPreferences, upload?: StartupMediaUpload) {
  const config = normalizeStartupPreferences(value);
  const job = saving
    .catch(() => undefined)
    .then(async () => {
      await loadStartupPreferences();
      if (upload && (!config.media || config.media.id !== upload.media.id))
        throw new Error('动画文件信息已改变');
      if (config.media && (upload || (config.style === 'media' && config.enabled)))
        await validateStartupMedia(config.media, upload);
      const previous = state.config;
      if (window.elysia?.saveStartup) {
        let nativeUpload: { media: StartupMedia; dataUrl: string } | undefined;
        if (upload) {
          const blob = await uploadBlob(upload);
          const bytes = new Uint8Array(await blob.arrayBuffer()),
            chunks: string[] = [];
          for (let offset = 0; offset < bytes.length; offset += 8192)
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
          nativeUpload = {
            media: upload.media,
            dataUrl: `data:${upload.media.mime};base64,${btoa(chunks.join(''))}`,
          };
        }
        await window.elysia.saveStartup(config, nativeUpload);
      } else {
        let created = false;
        if (upload) {
          const blob = await uploadBlob(upload),
            existing = await mediaTransaction('readonly', (store) => store.get(upload.media.id));
          await mediaTransaction('readwrite', (store) => store.put(blob, upload.media.id));
          created = !(existing instanceof Blob);
        } else if (config.media && previous.media?.id !== config.media.id)
          throw new Error('请重新导入动画文件');
        try {
          localStorage.setItem(storageKey, JSON.stringify(config));
        } catch {
          if (created)
            await mediaTransaction('readwrite', (store) => store.delete(upload!.media.id)).catch(() => {});
          throw new Error('浏览器存储不可用或空间不足，原偏好已保留。');
        }
        if (previous.media && previous.media.id !== config.media?.id)
          void mediaTransaction('readwrite', (store) => store.delete(previous.media!.id)).catch(() => {});
      }
      generation++;
      if (previous.media?.id !== config.media?.id) clearMediaCache();
      publish({ config, loaded: true, error: '', desktopBootShown: state.desktopBootShown });
      return config;
    });
  saving = job;
  return job;
}
/**
 * 导入仅接受不超过 4 MiB 的本地 GIF/MP4/WebM，再由 fromBlob 核对实际内容并生成摘要。
 * EN: Import local GIF/MP4/WebM up to 4 MiB, then fromBlob validates bytes and creates digest.
 */
export async function importStartupFile(file: File): Promise<StartupMediaUpload> {
  if (!file.size || file.size > startupMediaLimit) throw new Error('请选择不超过 4 MiB 的本地动画文件');
  const mime = ({ gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' } as const)[
    file.name.split('.').at(-1)?.toLowerCase() as 'gif' | 'mp4' | 'webm'
  ];
  if (!mime) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
  return fromBlob(file.name, mime, file);
}
/**
 * 所有启动界面共享同一个外部存储快照；首次挂载触发幂等加载。
 * EN: All startup views share one external-store snapshot; first mount triggers idempotent loading.
 */
export function useStartupPreferences() {
  const value = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void loadStartupPreferences();
  }, []);
  return value;
}
