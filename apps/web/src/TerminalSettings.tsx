import { useEffect, useRef, useState } from 'react';
import { SurfaceTerminalSettings, type AgentTerminalProfile } from '../../../packages/contracts/src/index';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { TerminalSetup, terminalPreset } from './TerminalSetup';
import './surface.css';
import './terminal-control.css';

export function TerminalSettings({
  initial,
  close,
  updated,
  activity,
  embedded = false,
  dirtyChanged,
}: {
  initial: SurfaceTerminalSettings;
  close: () => void;
  updated: (settings: SurfaceTerminalSettings) => void | Promise<void>;
  activity: (busy: boolean) => void;
  embedded?: boolean;
  dirtyChanged?: (dirty: boolean) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [baseline, setBaseline] = useState(() => structuredClone(initial));
  const [latest, setLatest] = useState(initial);
  const [profiles, setProfiles] = useState(() => structuredClone(baseline.profiles));
  const [defaultProfileId, setDefaultProfileId] = useState(baseline.defaultProfileId);
  const [selectedId, setSelectedId] = useState(baseline.defaultProfileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const submitting = useRef(false);
  const selected = profiles.find((profile) => profile.id === selectedId)!;
  const valid = SurfaceTerminalSettings.safeParse({
    revision: baseline.revision,
    profiles,
    defaultProfileId,
  }).success;
  const changed =
    JSON.stringify(profiles) !== JSON.stringify(baseline.profiles) ||
    defaultProfileId !== baseline.defaultProfileId;
  function adopt(next: SurfaceTerminalSettings) {
    setBaseline(structuredClone(next));
    setProfiles(structuredClone(next.profiles));
    setDefaultProfileId(next.defaultProfileId);
    setSelectedId((id) => (next.profiles.some((profile) => profile.id === id) ? id : next.defaultProfileId));
    setError('');
    setConfirmClose(false);
    dirtyChanged?.(false);
  }
  useEffect(() => {
    if (initial.revision >= latest.revision) setLatest(initial);
  }, [initial, latest.revision]);
  useEffect(() => {
    if (!changed && latest.revision !== baseline.revision) adopt(latest);
  }, [latest, baseline.revision, changed]);
  useEffect(() => dirtyChanged?.(changed), [changed, dirtyChanged]);
  const requestClose = () => {
    if (busy) return;
    if (!embedded && changed) setConfirmClose(true);
    else close();
  };
  const form = (
    <form
      onSubmit={async (event) => {
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
            <span>模板已更新；载入最新将替换当前修改。</span>
            <button type="button" className="secondary" disabled={busy} onClick={() => adopt(latest)}>
              载入最新模板
            </button>
          </div>
        )}
        {error && (
          <p className="inline-warning" role="alert">
            {error}
          </p>
        )}
        <div className="terminal-settings-body">
          <div className="terminal-settings-list" aria-label="终端模板">
            <div className="terminal-settings-profiles">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  aria-current={profile.id === selectedId ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => setSelectedId(profile.id)}
                >
                  <span>{profile.label || '未命名模板'}</span>
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
          <div className="terminal-settings-editor">
            <div className="terminal-settings-actions">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={selectedId === defaultProfileId}
                  disabled={busy || selectedId === defaultProfileId}
                  onChange={() => setDefaultProfileId(selectedId)}
                />
                新任务默认使用
              </label>
              <button
                type="button"
                className="text-button danger"
                disabled={busy || profiles.length <= 1}
                onClick={() => {
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
            <TerminalSetup
              key={`${selected.id}:${baseline.revision}`}
              value={selected}
              disabled={busy}
              change={(profile) =>
                setProfiles((current) => current.map((item) => (item.id === selectedId ? profile : item)))
              }
            />
          </div>
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
