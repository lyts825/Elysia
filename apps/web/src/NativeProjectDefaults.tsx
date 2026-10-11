import { useEffect, useRef, useState } from 'react';
import type {
  NativeProjectDefaults,
  NativeProjectDefaultsRecord,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';

export function NativeProjectDefaultsPanel({
  projectId,
  value,
  canSave,
  edited,
  apply,
  activity,
}: {
  projectId: string;
  value: NativeProjectDefaults;
  canSave: boolean;
  edited: () => boolean;
  apply: (defaults: NativeProjectDefaults) => void;
  activity: (busy: boolean) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [record, setRecord] = useState<NativeProjectDefaultsRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const current = useRef({ edited, apply, activity });
  current.current = { edited, apply, activity };
  useEffect(() => {
    const controller = new AbortController();
    setRecord(undefined);
    setError('');
    void api<NativeProjectDefaultsRecord>(
      `/projects/${projectId}/native-defaults`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setRecord(next);
        if (next.defaults && !current.current.edited() && retry === 0) {
          current.current.apply(next.defaults);
          setNotice('已载入项目默认。请核对本次执行范围。');
        } else setNotice(next.defaults ? '项目默认可用；当前输入已保留，可手动载入。' : '尚未保存项目默认。');
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '项目默认读取失败。');
      });
    return () => controller.abort();
  }, [api, projectId, retry]);
  async function save() {
    if (!record || busy || !canSave) return;
    setBusy(true);
    activity(true);
    setError('');
    try {
      const next = await mutation<NativeProjectDefaultsRecord>(
        `/projects/${projectId}/native-defaults`,
        {
          expectedRevision: record.revision,
          defaults: value,
        },
        'PUT',
      );
      setRecord(next);
      setNotice('项目默认已保存，下次创建任务时复用。');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '保存失败，当前输入已保留。');
    } finally {
      setBusy(false);
      current.current.activity(false);
    }
  }
  return (
    <section className="workflow-defaults" aria-label="项目默认配置">
      <div>
        <strong>项目默认</strong>
        <span role="status">{notice || '正在读取项目默认…'}</span>
      </div>
      <p className="field-help">复用模型、计划、上下文和预算；执行权限由本次任务单独确认。</p>
      {error && (
        <p className="field-error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setRetry((v) => v + 1)}
          >
            重新读取
          </button>
        </p>
      )}
      <div className="workflow-actions">
        {record?.defaults && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              apply(record.defaults!);
              setNotice('已载入项目默认，请核对当前配置。');
            }}
          >
            载入项目默认
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={!record || busy || !canSave}
          onClick={() => void save()}
        >
          {busy ? '正在保存…' : '保存为项目默认'}
        </button>
      </div>
    </section>
  );
}
