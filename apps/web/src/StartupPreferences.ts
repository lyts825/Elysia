import { useEffect, useSyncExternalStore } from 'react';
import './desktop';

export type StartupMedia = { name: string; mime: 'image/gif' | 'video/mp4' | 'video/webm'; dataUrl: string };
export type StartupPreferences = {
  version: 1;
  enabled: boolean;
  style: 'bloom' | 'orbit' | 'minimal' | 'media';
  title: string;
  caption: string;
  accent: string;
  background: string;
  media?: StartupMedia;
};
export const defaultStartupPreferences: StartupPreferences = {
  version: 1,
  enabled: true,
  style: 'bloom',
  title: 'Elysia',
  caption: '把想法，慢慢做成喜欢的日常。',
  accent: '#bd8c96',
  background: '#f8faf5',
};
export const startupMediaLimit = 4 * 1024 * 1024;
const storageKey = 'elysia:startup:v1';

function verifyBytes(bytes: Uint8Array, mime: StartupMedia['mime']) {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const valid =
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(text(0, 6))) ||
    (mime === 'video/mp4' && bytes.length >= 12 && text(4, 8) === 'ftyp') ||
    (mime === 'video/webm' && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value));
  if (!valid || !bytes.length || bytes.length > startupMediaLimit)
    throw new Error('仅支持不超过 4 MiB 的有效 GIF、MP4 或 WebM 动画');
}

export function normalizeStartupPreferences(value: unknown): StartupPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('启动偏好无效');
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
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
    version: 1,
    enabled: v.enabled,
    style: v.style as StartupPreferences['style'],
    title: v.title.trim(),
    caption: v.caption.trim(),
    accent: v.accent.toLowerCase(),
    background: v.background.toLowerCase(),
  };
  if (v.media !== undefined) {
    const media = v.media as Record<string, unknown>;
    if (
      !media ||
      typeof media !== 'object' ||
      typeof media.name !== 'string' ||
      media.name.length > 120 ||
      !['image/gif', 'video/mp4', 'video/webm'].includes(media.mime as string) ||
      typeof media.dataUrl !== 'string' ||
      media.dataUrl.length > Math.ceil(startupMediaLimit / 3) * 4 + 64
    )
      throw new Error('动画文件无效');
    const prefix = `data:${media.mime};base64,`;
    if (!media.dataUrl.startsWith(prefix)) throw new Error('动画必须是本地导入文件');
    const encoded = media.dataUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('动画编码无效');
    let raw: string;
    try {
      raw = atob(encoded);
    } catch {
      throw new Error('动画编码无效');
    }
    if (btoa(raw) !== encoded) throw new Error('动画编码无效');
    verifyBytes(
      Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      media.mime as StartupMedia['mime'],
    );
    config.media = {
      name: media.name.replace(/[\x00-\x1f]/g, '').slice(0, 120),
      mime: media.mime as StartupMedia['mime'],
      dataUrl: media.dataUrl,
    };
  }
  if (config.style === 'media' && !config.media) throw new Error('请先导入动画文件');
  return config;
}

type PreferenceState = { config: StartupPreferences; loaded: boolean; error: string };
let state: PreferenceState = { config: defaultStartupPreferences, loaded: false, error: '' };
let loadPromise: Promise<void> | undefined;
let generation = 0;
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

export function loadStartupPreferences() {
  if (loadPromise) return loadPromise;
  const current = generation;
  loadPromise = (async () => {
    try {
      let value: unknown;
      if (window.elysia?.readStartup) value = await window.elysia.readStartup();
      else {
        const raw = localStorage.getItem(storageKey);
        if (raw && raw.length > 6 * 1024 * 1024) throw new Error('已保存的动画超过大小限制');
        value = raw ? JSON.parse(raw) : defaultStartupPreferences;
      }
      const config = normalizeStartupPreferences(value);
      if (generation === current) publish({ config, loaded: true, error: '' });
    } catch {
      if (generation === current)
        publish({
          config: defaultStartupPreferences,
          loaded: true,
          error: '无法读取已保存的启动偏好，当前使用默认外观。',
        });
    }
  })();
  return loadPromise;
}

export async function saveStartupPreferences(value: StartupPreferences) {
  const config = normalizeStartupPreferences(value);
  generation++;
  if (window.elysia?.saveStartup) await window.elysia.saveStartup(config);
  else {
    try {
      localStorage.setItem(storageKey, JSON.stringify(config));
    } catch {
      throw new Error('浏览器存储不可用或空间不足，请缩小动画文件后重试。');
    }
  }
  publish({ config, loaded: true, error: '' });
}

export async function importStartupFile(file: File): Promise<StartupMedia> {
  if (!file.size || file.size > startupMediaLimit) throw new Error('请选择不超过 4 MiB 的本地动画文件');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const mime = ({ gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' } as const)[
    extension as 'gif' | 'mp4' | 'webm'
  ];
  if (!mime) throw new Error('仅支持 GIF、MP4 或 WebM 动画');
  const bytes = new Uint8Array(await file.arrayBuffer());
  verifyBytes(bytes, mime);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return { name: file.name.slice(0, 120), mime, dataUrl: `data:${mime};base64,${btoa(chunks.join(''))}` };
}

export function useStartupPreferences() {
  const value = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void loadStartupPreferences();
  }, []);
  return value;
}
