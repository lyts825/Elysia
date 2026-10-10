import { useRef, useState } from 'react';
import { SurfaceTerminalSettings, type AgentTerminalProfile } from '../../../packages/contracts/src/index';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { TerminalSetup, terminalPreset } from './TerminalSetup';
import './surface.css';

export function TerminalSettings({
  initial,
  close,
  updated,
  activity,
  embedded = false,
}: {
  initial: SurfaceTerminalSettings;
  close: () => void;
  updated: (settings: SurfaceTerminalSettings) => void;
  activity: (busy: boolean) => void;
  embedded?: boolean;
}) {
  const { mutation } = useSurfaceClient();
  const [baseline] = useState(() => structuredClone(initial));
  const [profiles, setProfiles] = useState(() => structuredClone(baseline.profiles));
  const [defaultProfileId, setDefaultProfileId] = useState(baseline.defaultProfileId);
  const [selectedId, setSelectedId] = useState(baseline.defaultProfileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
          updated(saved);
          close();
        } catch (issue) {
          setError(
            issue instanceof ApiError && issue.code === 'REVISION_CONFLICT'
              ? '模板已在另一窗口更新。当前修改已保留，请关闭并重新打开设置后核对。'
              : issue instanceof Error
                ? issue.message
                : '无法保存终端设置，请重试。',
          );
        } finally {
          submitting.current = false;
          setBusy(false);
          activity(false);
        }
      }}
    >
      <div className="form-body">
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
              key={selected.id}
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
        <button type="button" className="secondary" disabled={busy} onClick={close}>
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
    <Modal title="终端模板" subtitle="用于新任务，现有任务保留原配置。" close={close} busy={busy} wide>
      {form}
    </Modal>
  );
}
