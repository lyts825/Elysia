import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { StartupVisual, startupColors } from './StartupTransition';
import {
  defaultStartupPreferences,
  importStartupFile,
  saveStartupPreferences,
  useStartupPreferences,
  type StartupPreferences,
} from './StartupPreferences';

export function StartupSettings({ close }: { close: () => void }) {
  const { config, loaded, error: readError } = useStartupPreferences();
  const [draft, setDraft] = useState<StartupPreferences>(config);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty) setDraft(config);
  }, [config, dirty]);
  function change(value: Partial<StartupPreferences>) {
    setDirty(true);
    setSaved(false);
    setError('');
    setDraft((previous) => ({ ...previous, ...value }));
  }
  async function importMedia(file?: File) {
    setBusy(true);
    setError('');
    try {
      const media = file ? await importStartupFile(file) : await window.elysia?.importStartupMedia?.();
      if (media && mounted.current) change({ media, style: 'media', enabled: true });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await saveStartupPreferences(draft);
      if (mounted.current) {
        setDirty(false);
        setSaved(true);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="外观与启动"
      subtitle="在这台设备上保存；两种工作台入口共用。"
      close={close}
      className="startup-settings"
      busy={busy}
    >
      <div className="startup-settings-body">
        <div className="startup-settings-preview" style={startupColors(draft)}>
          <StartupVisual config={draft} />
          <strong>{draft.title || 'Elysia'}</strong>
          <p>{draft.caption}</p>
        </div>
        {(error || readError) && (
          <p className="startup-settings-error" role="alert">
            {error || readError}
          </p>
        )}
        <label className="startup-settings-toggle">
          <span>启动时显示动画</span>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
        </label>
        <div className="startup-styles" role="group" aria-label="动画样式">
          {(
            [
              ['bloom', '柔光'],
              ['orbit', '环绕'],
              ['minimal', '简约'],
              ['media', '本地动画'],
            ] as const
          ).map(([style, label]) => (
            <button
              key={style}
              className={'secondary' + (draft.style === style ? ' selected' : '')}
              aria-pressed={draft.style === style}
              disabled={busy || (style === 'media' && !draft.media)}
              onClick={() => change({ style })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="startup-settings-fields">
          <label>
            标题
            <input
              value={draft.title}
              maxLength={64}
              disabled={busy}
              onChange={(event) => change({ title: event.target.value })}
            />
          </label>
          <label>
            短句
            <input
              value={draft.caption}
              maxLength={100}
              disabled={busy}
              onChange={(event) => change({ caption: event.target.value })}
            />
          </label>
          <div className="startup-color-fields">
            <label>
              点缀色
              <input
                type="color"
                value={draft.accent}
                disabled={busy}
                onChange={(event) => change({ accent: event.target.value })}
              />
            </label>
            <label>
              背景色
              <input
                type="color"
                value={draft.background}
                disabled={busy}
                onChange={(event) => change({ background: event.target.value })}
              />
            </label>
          </div>
        </div>
        <div className="startup-media-tools">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => (window.elysia?.importStartupMedia ? void importMedia() : input.current?.click())}
          >
            导入本地动画
          </button>
          {draft.media && (
            <>
              <span title={draft.media.name}>{draft.media.name}</span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  change({ media: undefined, style: draft.style === 'media' ? 'bloom' : draft.style })
                }
              >
                移除
              </button>
            </>
          )}
          <input
            ref={input}
            type="file"
            accept=".gif,.mp4,.webm"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importMedia(file);
            }}
          />
        </div>
        <p className="startup-settings-hint">
          GIF、MP4 或 WebM，最大 4 MiB。动画静音播放，工作台就绪后立即进入；减少动态效果时使用静态样式。
        </p>
        <footer>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setDraft({ ...defaultStartupPreferences });
              setDirty(true);
              setSaved(false);
              setError('');
            }}
          >
            恢复默认
          </button>
          <span role="status">{saved ? '已保存，下次启动生效' : !loaded ? '正在读取偏好…' : ''}</span>
          <button
            className="primary"
            disabled={busy || !loaded || !draft.title.trim()}
            onClick={() => void save()}
          >
            {busy ? '处理中…' : '保存'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
