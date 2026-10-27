/* 编辑应用启动设置。 */
import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import { StartupVisual, startupColors } from './StartupTransition';
import {
  defaultStartupPreferences,
  importStartupFile,
  saveStartupPreferences,
  useStartupPreferences,
  validateStartupMedia,
  type StartupPreferences,
  type StartupMediaUpload,
} from './StartupPreferences';
import {
  readStartupDiagnostics,
  type StartupDiagnosticSnapshot,
  type StartupStage,
} from './StartupDiagnostics';
import './startup-settings.css';

const stageLabels: Record<StartupStage, string> = {
  'launch-entry': '启动入口',
  'dependencies-ready': '依赖检查',
  'fingerprint-ready': '构建检查',
  'build-ready': '构建就绪',
  'window-visible': '窗口显示',
  'backend-ready': '本机服务',
  'web-loaded': '工作台加载',
  'preferences-ready': '外观偏好',
  'auth-ready': '登录就绪',
  'lists-ready': '首批历史',
  'messages-ready': '首批消息',
  'media-ready': '动画就绪',
};

export function StartupSettings({ close }: { close: () => void }) {
  const { config, loaded, error: readError } = useStartupPreferences();
  const fieldsId = useId();
  const [draft, setDraft] = useState<StartupPreferences>(config);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [upload, setUpload] = useState<StartupMediaUpload>();
  const [diagnostics, setDiagnostics] = useState<StartupDiagnosticSnapshot>();
  const [diagnosticError, setDiagnosticError] = useState('');
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
      const imported = file ? await importStartupFile(file) : await window.elysia?.importStartupMedia?.();
      if (imported) {
        await validateStartupMedia(imported.media, imported);
        if (mounted.current) {
          setUpload(imported);
          change({ media: imported.media, style: 'media', enabled: true });
        }
      }
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
      await saveStartupPreferences(draft, upload);
      if (mounted.current) {
        setDirty(false);
        setSaved(true);
        setUpload(undefined);
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
      className="startup-settings startup-preferences-panel"
      busy={busy}
    >
      <div className="startup-settings-body">
        <div className="startup-settings-preview" style={startupColors(draft)}>
          <StartupVisual config={draft} upload={upload} onError={setError} />
          <strong>{draft.title || 'Elysia'}</strong>
          <p>{draft.caption}</p>
        </div>
        <p className="startup-settings-hint">上方为当前草稿预览；保存后供下次启动使用。</p>
        {(error || readError) && (
          <p
            className="startup-settings-error startup-preferences-reading"
            role="alert"
            tabIndex={0}
            aria-label="启动外观完整错误"
          >
            {error || readError}
          </p>
        )}
        <section className="startup-preferences-group" aria-label="启动行为设置">
          <h3>启动行为</h3>
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
        </section>
        <section className="startup-preferences-group" aria-label="启动文字与颜色设置">
          <h3>文字与颜色</h3>
          <div className="startup-settings-fields">
            <label>
              标题
              <input
                aria-describedby={`${fieldsId}-title-help`}
                aria-invalid={!draft.title.trim() || undefined}
                value={draft.title}
                maxLength={64}
                disabled={busy}
                onChange={(event) => change({ title: event.target.value })}
              />
              <small id={`${fieldsId}-title-help`} className="startup-preferences-field-help">
                {draft.title.length} / 64 字符{!draft.title.trim() ? ' · 标题不能为空，填写后可保存' : ''}
              </small>
            </label>
            <label>
              短句
              <input
                aria-describedby={`${fieldsId}-caption-help`}
                value={draft.caption}
                maxLength={100}
                disabled={busy}
                onChange={(event) => change({ caption: event.target.value })}
              />
              <small id={`${fieldsId}-caption-help`} className="startup-preferences-field-help">
                {draft.caption.length} / 100 字符
              </small>
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
                <output className="startup-preferences-color-value" aria-label="当前点缀色原值">
                  {draft.accent}
                </output>
              </label>
              <label>
                背景色
                <input
                  type="color"
                  value={draft.background}
                  disabled={busy}
                  onChange={(event) => change({ background: event.target.value })}
                />
                <output className="startup-preferences-color-value" aria-label="当前背景色原值">
                  {draft.background}
                </output>
              </label>
            </div>
          </div>
        </section>
        <section className="startup-preferences-group" aria-label="本地动画文件设置">
          <h3>本地动画文件</h3>
          <div className="startup-media-tools">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                window.elysia?.importStartupMedia ? void importMedia() : input.current?.click()
              }
            >
              导入本地动画
            </button>
            {draft.media && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setUpload(undefined);
                  change({ media: undefined, style: draft.style === 'media' ? 'bloom' : draft.style });
                }}
              >
                移除动画
              </button>
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
          {draft.media ? (
            <>
              <p className="startup-settings-hint">
                {draft.style === 'media'
                  ? '当前草稿已选择此本地动画样式。'
                  : '文件仍保留，当前草稿使用其他动画样式。'}
                {upload && '新导入文件尚未保存。'}
              </p>
              <dl
                className="startup-preferences-media startup-preferences-reading"
                role="region"
                aria-label="当前动画文件完整信息"
                tabIndex={0}
              >
                <div>
                  <dt>完整文件名</dt>
                  <dd>{draft.media.name}</dd>
                </div>
                <div>
                  <dt>格式</dt>
                  <dd>{draft.media.mime}</dd>
                </div>
                <div>
                  <dt>文件大小</dt>
                  <dd>{draft.media.size.toLocaleString()} 字节 / 最大 4 MiB</dd>
                </div>
                <div>
                  <dt>文件 SHA-256</dt>
                  <dd>{draft.media.id}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="startup-settings-hint">尚未导入本地动画。</p>
          )}
          <p className="startup-settings-hint">
            GIF、MP4 或 WebM，最大 4 MiB。动画静音播放，工作台就绪后立即进入；减少动态效果时使用静态样式。
          </p>
        </section>
        <details
          className="startup-diagnostics"
          onToggle={(event) => {
            if (event.target !== event.currentTarget) return;
            if (!event.currentTarget.open) return;
            setDiagnosticError('');
            void readStartupDiagnostics()
              .then((value) => {
                if (mounted.current) setDiagnostics(value);
              })
              .catch(() => {
                if (mounted.current) setDiagnosticError('暂时无法读取启动耗时');
              });
          }}
        >
          <summary>启动耗时</summary>
          <p className="startup-settings-hint">
            记录最近 20 次启动，仅含阶段和耗时；构建缓存状态不代表操作系统文件缓存。各阶段从本次启动入口计时。
          </p>
          {diagnosticError && (
            <p
              role="alert"
              className="startup-preferences-reading"
              tabIndex={0}
              aria-label="启动耗时读取失败"
            >
              {diagnosticError}。
              {diagnostics ? '下方保留上次已读记录，可收起后重新展开读取。' : '可收起后重新展开读取。'}
            </p>
          )}
          {diagnostics && (
            <p className="startup-settings-hint">已读 {diagnostics.records.slice(0, 20).length} 次启动记录</p>
          )}
          {diagnostics?.records.slice(0, 20).map((record, index) => (
            <div key={record.id} className="startup-diagnostic-record">
              <details className="startup-preferences-record">
                <summary>
                  记录 {index + 1} · {new Date(record.startedAt).toLocaleString()} ·{' '}
                  {record.environment === 'desktop' ? '桌面' : '浏览器'} ·{' '}
                  {record.build === 'cached'
                    ? '复用构建'
                    : record.build === 'rebuilt'
                      ? '重新构建'
                      : '构建状态未知'}
                </summary>
                <dl
                  className="startup-preferences-reading"
                  role="region"
                  tabIndex={0}
                  aria-label={`第 ${index + 1} 次启动完整阶段耗时`}
                >
                  {record.stages.map((mark) => (
                    <div key={`${mark.stage}:${mark.surface || ''}:${mark.status}`}>
                      <dt>
                        {stageLabels[mark.stage]}
                        {mark.surface ? ` · ${mark.surface === 'terminal' ? '终端' : 'Elysia'}` : ''}
                        {mark.status === 'skipped' ? '（跳过）' : mark.status === 'error' ? '（失败）' : ''}
                      </dt>
                      <dd>{mark.elapsedMs.toFixed(1)} ms</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </div>
          ))}
          {diagnostics && !diagnostics.records.length && <p>暂无启动记录</p>}
        </details>
        <footer className="startup-preferences-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setDraft({ ...defaultStartupPreferences });
              setDirty(true);
              setSaved(false);
              setError('');
              setUpload(undefined);
            }}
          >
            恢复默认
          </button>
          <span role="status">
            {busy
              ? '正在处理本机外观设置…'
              : saved
                ? '已保存，下次启动生效'
                : !loaded
                  ? '正在读取偏好…'
                  : dirty
                    ? '当前预览有未保存修改'
                    : readError
                      ? '偏好读取有问题，请核对上方说明'
                      : '显示已读偏好，修改后需保存'}
          </span>
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
