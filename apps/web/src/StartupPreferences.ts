/* 管理启动阶段使用的本地偏好设置。 */
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

export function normalizeStartupMedia(value: unknown): StartupMedia {
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
export function normalizeStartupPreferences(value: unknown): StartupPreferences {
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
function verifyBytes(bytes: Uint8Array, mime: StartupMedia['mime']) {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const valid =
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(text(0, 6))) ||
    (mime === 'video/mp4' && bytes.length >= 12 && text(4, 8) === 'ftyp') ||
    (mime === 'video/webm' && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value));
  if (!valid || !bytes.length || bytes.length > startupMediaLimit)
    throw new Error('仅支持不超过 4 MiB 的有效 GIF、MP4 或 WebM 动画');
}
async function digest(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
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
function publish(next: PreferenceState) {
  state = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let mediaCache: { id: string; pending: Promise<string>; url?: string } | undefined;
function clearMediaCache() {
  if (mediaCache?.url?.startsWith('blob:')) URL.revokeObjectURL(mediaCache.url);
  mediaCache = undefined;
}
window.addEventListener('pagehide', clearMediaCache);

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
      const finish = (error?: Error) => {
        cleanup();
        error ? reject(error) : resolve();
      };
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
export async function importStartupFile(file: File): Promise<StartupMediaUpload> {
  if (!file.size || file.size > startupMediaLimit) throw new Error('请选择不超过 4 MiB 的本地动画文件');
  const mime = ({ gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' } as const)[
    file.name.split('.').at(-1)?.toLowerCase() as 'gif' | 'mp4' | 'webm'
  ];
  if (!mime) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
  return fromBlob(file.name, mime, file);
}
export function useStartupPreferences() {
  const value = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void loadStartupPreferences();
  }, []);
  return value;
}
