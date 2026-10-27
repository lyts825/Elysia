/**
 * 管理终端相关设置。
 *
 * EN: Manages terminal settings.
 *
 * 本模块编辑多终端模板与默认模板，分别保留本地草稿、提交基线和最新服务端版本；脏草稿保护及冲突展示防止后台更新覆盖输入，保存通过版本化 API 提交。
 * EN: Edits profiles/default selection while retaining local drafts, submission baselines, and the latest server version separately. Dirty-state protection/conflict UI prevent background overwrites; versioned APIs perform saves.
 */
import { useEffect, useRef, useState } from 'react';
import { SurfaceTerminalSettings, type AgentTerminalProfile } from '../../../packages/contracts/src/index';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { TerminalSetup, terminalPreset } from './TerminalSetup';
import './surface.css';
import './terminal-control.css';
import './terminal-profile-settings.css';

/**
 * 编辑终端模板及默认选择。baseline 是提交时的版本基线，profiles 是本地草稿；
 * 后台数据更新不会覆盖尚未保存的修改。
 *
 * EN: Edits templates/defaults with baseline as the submission revision and profiles as local drafts. Background updates never overwrite dirty changes.
 */
export function TerminalSettings({
  initial,
  close,
  updated,
  activity,
  embedded = false,
  dirtyChanged,
  focusProfileId,
  focusRequest,
  focusHandled,
  reload,
  reloading = false,
  connectionOptions,
}: {
  initial: SurfaceTerminalSettings;
  close: () => void;
  updated: (settings: SurfaceTerminalSettings) => void | Promise<void>;
  activity: (busy: boolean) => void;
  embedded?: boolean;
  dirtyChanged?: (dirty: boolean) => void;
  focusProfileId?: string;
  focusRequest?: number;
  focusHandled?: () => void;
  reload?: () => void;
  reloading?: boolean;
  connectionOptions?: Partial<
    Record<
      AgentTerminalProfile['agent'],
      import('../../../packages/contracts/src/index').TerminalConnectionView[]
    >
  >;
}) {
  const { api, mutation } = useSurfaceClient();
  const [baseline, setBaseline] = useState(() => structuredClone(initial));
  /**
   * latest 跟踪后台新版本，baseline 固定用户开始编辑时的依据，两者不可在脏草稿中自动合并。
   *
   * EN: latest follows newer server data while baseline fixes the editing origin; they cannot auto-merge into a dirty draft.
   */
  const [latest, setLatest] = useState(initial);
  const [profiles, setProfiles] = useState(() => structuredClone(baseline.profiles));
  const [defaultProfileId, setDefaultProfileId] = useState(baseline.defaultProfileId);
  const [selectedId, setSelectedId] = useState(focusProfileId ?? baseline.defaultProfileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusIssue, setFocusIssue] = useState('');
  const focusIntent = useRef({ id: focusProfileId, request: focusRequest, handled: false });
  const handledCallback = useRef(focusHandled);
  handledCallback.current = focusHandled;
  const submitting = useRef(false);
  const editorTitle = useRef<HTMLHeadingElement>(null);
  const focusEditor = useRef(false);
  const selected = profiles.find((profile) => profile.id === selectedId);
  const selectedConnection = selected?.connectionId
    ? connectionOptions?.[selected.agent]?.find((connection) => connection.id === selected.connectionId)
    : undefined;
  const connectionSource =
    selected?.connectionId === undefined
      ? '跟随项目与应用默认'
      : selected.connectionId === null
        ? '只使用模板环境变量'
        : selectedConnection
          ? '模板指定连接'
          : connectionOptions
            ? '指定连接已失效或不兼容，请重选'
            : '模板指定连接（当前未提供连接目录）';
  /**
   * 手动定位模板后把编辑标题滚入视口并聚焦，帮助键盘和读屏用户确认切换目标。
   *
   * EN: Scrolls/focuses the template editor title after manual navigation for keyboard/screen-reader orientation.
   */
  function revealEditor() {
    editorTitle.current?.scrollIntoView({ block: 'start' });
    editorTitle.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (focusEditor.current) {
      focusEditor.current = false;
      revealEditor();
    }
  }, [selectedId]);
  /**
   * 只消费一次外部定位意图，避免父组件刷新后反复抢夺用户选中项。
   *
   * EN: Consumes an external focus intent once so parent refreshes cannot repeatedly steal selection.
   */
  function finishFocus() {
    focusIntent.current.handled = true;
    setFocusIssue('');
    handledCallback.current?.();
  }
  const valid = SurfaceTerminalSettings.safeParse({
    revision: baseline.revision,
    profiles,
    defaultProfileId,
  }).success;
  const changed =
    JSON.stringify(profiles) !== JSON.stringify(baseline.profiles) ||
    defaultProfileId !== baseline.defaultProfileId;
  /**
   * 用服务端配置重置草稿与基线，并尽量保留当前选中模板。
   *
   * EN: Resets draft/baseline from server settings while retaining the selected template where possible.
   */
  function adopt(next: SurfaceTerminalSettings) {
    setBaseline(structuredClone(next));
    setProfiles(structuredClone(next.profiles));
    setDefaultProfileId(next.defaultProfileId);
    setSelectedId((id) =>
      !focusIntent.current.handled && focusIntent.current.id
        ? focusIntent.current.id
        : next.profiles.some((profile) => profile.id === id)
          ? id
          : next.defaultProfileId,
    );
    setError('');
    setConfirmClose(false);
    dirtyChanged?.(false);
  }
  useEffect(() => {
    if (initial.revision >= latest.revision) setLatest(initial);
  }, [initial, latest.revision]);
  useEffect(() => {
    /**
     * 只有本地没有改动时才自动采用较新的服务端配置。
     *
     * EN: Automatically adopts newer server settings only when the local draft is clean.
     */
    if (!changed && latest.revision !== baseline.revision) adopt(latest);
  }, [latest, baseline.revision, changed]);
  useEffect(() => dirtyChanged?.(changed), [changed, dirtyChanged]);
  /**
   * 定位到另一模板前保留所有 profiles 草稿；若当前有改动则显示独立的切换确认。
   *
   * EN: Preserves all profile drafts before navigating to another template; dirty edits require a separate switch confirmation.
   */
  useEffect(() => {
    if (focusIntent.current.id !== focusProfileId || focusIntent.current.request !== focusRequest)
      focusIntent.current = { id: focusProfileId, request: focusRequest, handled: false };
    if (!focusProfileId || focusIntent.current.handled || busy) return;
    if (!profiles.some((profile) => profile.id === focusProfileId)) {
      setFocusIssue(
        '当前模板列表中未找到对应模板，可能已删除。可重新读取模板记录，或手动选择其他模板。当前修改会保留。',
      );
      return;
    }
    if (changed && selectedId !== focusProfileId) setPendingFocus(focusProfileId);
    else setSelectedId(focusProfileId);
    finishFocus();
  }, [focusProfileId, focusRequest, profiles, changed, selectedId, busy]);
  /**
   * 独立对话框关闭需要脏状态确认；嵌入模式的离开保护交给外层终端控制中心。
   *
   * EN: Standalone close protects dirty state; embedded leave protection belongs to the outer control center.
   */
  const requestClose = () => {
    if (busy) return;
    if (!embedded && changed) setConfirmClose(true);
    else close();
  };
  const form = (
    <form
      className="terminal-profile-settings"
      onSubmit={async (event) => {
        /**
         * ref 立即加锁，保存带编辑基线 revision；后台冲突只更新 latest，不覆盖当前草稿。
         *
         * EN: A ref locks immediately; save binds baseline revision. Conflicts update latest, never the current draft.
         */
        event.preventDefault();
        if (submitting.current || !valid || !changed) return;
        submitting.current = true;
        setBusy(true);
        activity(true);
        setError('');
        try {
          const saved = await mutation<SurfaceTerminalSettings>(
            '/terminal/settings',
            { expectedRevision: baseline.revision, profiles, defaultProfileId },
            'PUT',
          );
          setLatest(saved);
          adopt(saved);
          await updated(saved);
          close();
        } catch (issue) {
          setError(
            issue instanceof ApiError && issue.code === 'REVISION_CONFLICT'
              ? '模板已更新，当前修改已保留。'
              : issue instanceof Error
                ? issue.message
                : '无法保存终端设置，请重试。',
          );
          if (issue instanceof ApiError && issue.code === 'REVISION_CONFLICT') {
            /**
             * 读取新版供用户比较/重新采用，保留原有输入及 baseline，不能悄悄重试覆盖。
             *
             * EN: Reads newer settings for comparison/adoption while preserving inputs/baseline, never silently retries an overwrite.
             */
            try {
              setLatest(await api<SurfaceTerminalSettings>('/terminal/settings'));
            } catch {}
          }
        } finally {
          submitting.current = false;
          setBusy(false);
          activity(false);
        }
      }}
    >
      <div className="form-body">
        <dl className="terminal-template-summary" aria-label="模板编辑状态">
          <div>
            <dt>模板</dt>
            <dd>{profiles.length} / 20</dd>
          </div>
          <div>
            <dt>编辑依据</dt>
            <dd>版本 {baseline.revision}</dd>
          </div>
          <div>
            <dt>当前草稿</dt>
            <dd>{changed ? '有未保存修改' : '与已读版本一致'}</dd>
          </div>
          <div>
            <dt>保存条件</dt>
            <dd role="status">
              {busy ? '正在保存' : !valid ? '请修正配置输入' : !changed ? '没有待保存修改' : '可提交保存'}
            </dd>
          </div>
        </dl>
        {pendingFocus && (
          <div className="terminal-control-confirm" role="group" aria-label="诊断模板定位确认">
            <span>当前模板修改已保留。是否切换到指定模板？</span>
            <button type="button" className="secondary" onClick={() => setPendingFocus(null)}>
              继续编辑
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (profiles.some((profile) => profile.id === pendingFocus)) setSelectedId(pendingFocus);
                else setFocusIssue('对应模板已不在当前列表中，当前修改已保留。请重新读取模板记录。');
                setPendingFocus(null);
              }}
            >
              保留修改并定位
            </button>
          </div>
        )}
        {focusIssue && (
          <div className="terminal-control-read-error" role="status" aria-label="终端模板定位提示">
            <p className="inline-warning">{focusIssue}</p>
            {reload && (
              <button type="button" className="secondary" disabled={busy || reloading} onClick={reload}>
                {reloading ? '正在读取模板记录…' : '重新读取模板记录'}
              </button>
            )}
          </div>
        )}
        {confirmClose && (
          <div className="terminal-control-confirm" role="group" aria-label="未保存模板确认">
            <span>模板修改尚未保存。</span>
            <button type="button" className="secondary" onClick={() => setConfirmClose(false)}>
              继续编辑
            </button>
            <button type="button" className="secondary danger" onClick={close}>
              放弃并关闭
            </button>
          </div>
        )}
        {latest.revision !== baseline.revision && (
          <div className="terminal-control-conflict" role="status">
            <span>
              已读最新版本 {latest.revision}，当前编辑依据为版本 {baseline.revision}；载入最新将替换当前修改。
            </span>
            <button type="button" className="secondary" disabled={busy} onClick={() => adopt(latest)}>
              载入最新模板
            </button>
          </div>
        )}
        {error && (
          <p className="terminal-profile-error" role="alert" aria-label="终端模板保存失败详情" tabIndex={0}>
            {error}
          </p>
        )}
        <div className="terminal-settings-body">
          <div className="terminal-settings-list" aria-label="终端模板">
            <div className="terminal-settings-profiles">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  data-profile-id={profile.id}
                  type="button"
                  aria-current={profile.id === selectedId ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => {
                    finishFocus();
                    setPendingFocus(null);
                    if (selectedId === profile.id) revealEditor();
                    else focusEditor.current = true;
                    setSelectedId(profile.id);
                  }}
                >
                  <span>
                    <strong>{profile.label || '未命名模板'}</strong>
                    <small>
                      {profile.agent} · {profile.id === selectedId ? '当前编辑' : '可选择'}
                      {profile.id === defaultProfileId ? ' · 新任务默认' : ''}
                    </small>
                  </span>
                  {profile.id === defaultProfileId && <Icon name="check" size={15} />}
                </button>
              ))}
            </div>
            <label>
              添加模板
              <select
                aria-label="添加终端模板"
                value=""
                disabled={busy || profiles.length >= 20}
                onChange={(event) => {
                  if (!event.target.value) return;
                  finishFocus();
                  const profile = terminalPreset(event.target.value as AgentTerminalProfile['agent']);
                  setProfiles((current) => [...current, profile]);
                  setSelectedId(profile.id);
                }}
              >
                <option value="">选择 Agent…</option>
                <option value="dsh">DSH</option>
                <option value="codex">Codex CLI</option>
                <option value="claude">Claude Code</option>
                <option value="gemini">Gemini CLI</option>
                <option value="custom">自定义 Agent</option>
              </select>
            </label>
          </div>
          {selected && (
            <div className="terminal-settings-editor">
              <h3
                className="terminal-settings-title"
                ref={editorTitle}
                tabIndex={0}
                aria-label="当前模板完整名称"
              >
                {selected.label || '未命名模板'}
              </h3>
              <details className="terminal-profile-identity">
                <summary>模板标识与连接版本</summary>
                <dl
                  className="terminal-template-reading"
                  tabIndex={0}
                  role="region"
                  aria-label="当前模板完整标识与连接信息"
                >
                  <div>
                    <dt>模板标识</dt>
                    <dd>{selected.id}</dd>
                  </div>
                  <div>
                    <dt>Agent</dt>
                    <dd>{selected.agent}</dd>
                  </div>
                  {selected.connectionId && (
                    <div>
                      <dt>连接标识</dt>
                      <dd>{selected.connectionId}</dd>
                    </div>
                  )}
                  {selectedConnection && (
                    <>
                      <div>
                        <dt>连接版本</dt>
                        <dd>{selectedConnection.revision}</dd>
                      </div>
                    </>
                  )}
                </dl>
              </details>
              <div className="terminal-settings-actions">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={selectedId === defaultProfileId}
                    disabled={busy || selectedId === defaultProfileId}
                    onChange={() => {
                      finishFocus();
                      setDefaultProfileId(selectedId);
                    }}
                  />
                  新任务默认使用
                </label>
                <button
                  type="button"
                  className="text-button danger"
                  disabled={busy || profiles.length <= 1}
                  onClick={() => {
                    finishFocus();
                    const remaining = profiles.filter((profile) => profile.id !== selectedId);
                    if (!remaining.length) return;
                    if (defaultProfileId === selectedId) setDefaultProfileId(remaining[0].id);
                    setProfiles(remaining);
                    setSelectedId(remaining[0].id);
                  }}
                >
                  删除模板
                </button>
              </div>
              {connectionOptions && (
                <label className="terminal-template-connection">
                  模板 API 连接
                  <select
                    aria-label="模板 API 连接"
                    disabled={busy}
                    value={
                      selected.connectionId === undefined
                        ? 'inherit'
                        : selected.connectionId === null
                          ? 'environment'
                          : selected.connectionId
                    }
                    onChange={(event) => {
                      finishFocus();
                      const value = event.target.value;
                      setProfiles((current) =>
                        current.map((profile) => {
                          if (profile.id !== selectedId) return profile;
                          const { connection: _, connectionId: __, ...remaining } = profile;
                          return value === 'inherit'
                            ? remaining
                            : { ...remaining, connectionId: value === 'environment' ? null : value };
                        }),
                      );
                    }}
                  >
                    <option value="inherit">跟随项目与应用默认</option>
                    <option value="environment">只使用模板环境变量</option>
                    {selected.connectionId &&
                      !(connectionOptions[selected.agent] || []).some(
                        (connection) => connection.id === selected.connectionId,
                      ) && (
                        <option value={selected.connectionId} disabled>
                          当前连接已失效或不兼容，请重选
                        </option>
                      )}
                    {(connectionOptions[selected.agent] || []).map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} · {connection.model}
                      </option>
                    ))}
                  </select>
                  <small className="field-help">模板指定优先于项目和应用默认；保存仅用于新任务。</small>
                </label>
              )}
              {(!connectionOptions || selected.connectionId) && (
                <section className="terminal-template-connection-state" aria-label="当前模板连接选择">
                  <p>{connectionSource}</p>
                  {selectedConnection && (
                    <dl
                      className="terminal-template-connection-reading"
                      role="region"
                      aria-label="当前模板连接完整名称与型号"
                      tabIndex={0}
                    >
                      <div>
                        <dt>连接</dt>
                        <dd>{selectedConnection.name}</dd>
                      </div>
                      <div>
                        <dt>型号</dt>
                        <dd>{selectedConnection.model}</dd>
                      </div>
                    </dl>
                  )}
                </section>
              )}
              <TerminalSetup
                key={`${selected.id}:${baseline.revision}`}
                value={selected}
                disabled={busy}
                change={(profile) => {
                  finishFocus();
                  setProfiles((current) => current.map((item) => (item.id === selectedId ? profile : item)));
                }}
              />
            </div>
          )}
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary" disabled={busy} onClick={requestClose}>
          返回
        </button>
        <button className="primary" disabled={busy || !valid || !changed}>
          {busy ? '正在保存…' : '保存设置'}
        </button>
      </footer>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal title="终端模板" subtitle="用于新任务，现有任务保留原配置。" close={requestClose} busy={busy} wide>
      {form}
    </Modal>
  );
}
