/* 编辑原生项目的默认运行配置。 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  NativeProjectDefaults,
  NativeProjectDefaultsRecord,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import './native-project-defaults.css';

function DefaultsSummary({ value }: { value: NativeProjectDefaults }) {
  return (
    <dl className="native-defaults-facts">
      <div>
        <dt>模型连接标识</dt>
        <dd>{value.modelChoice?.providerId || '未指定'}</dd>
      </div>
      <div>
        <dt>模型与推理强度</dt>
        <dd>
          {value.modelChoice?.model || '未指定'} · {value.modelChoice?.reasoningEffort || '默认'}
        </dd>
      </div>
      <div>
        <dt>计划模式</dt>
        <dd>{value.planMode ? '先规划，接受后执行' : '直接执行'}</dd>
      </div>
      <div>
        <dt>上下文</dt>
        <dd>
          {value.contextPolicy?.mode === 'manual'
            ? `${value.contextPolicy.windowTokens?.toLocaleString() || '未指定'} Token`
            : '托管'}
        </dd>
      </div>
      <div>
        <dt>预算上限</dt>
        <dd>
          {value.budget.maxRequests} 次请求 · {value.budget.maxTokens.toLocaleString()} Token ·{' '}
          {value.budget.maxCost == null ? '未设金额上限' : `金额 ${value.budget.maxCost}`}
        </dd>
      </div>
      <div>
        <dt>并发实例</dt>
        <dd>{value.concurrency}</dd>
      </div>
    </dl>
  );
}

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
  const helpId = useId();
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
    <section className="workflow-defaults native-project-defaults" aria-label="项目默认配置">
      <header>
        <h3>项目默认</h3>
        {record && <span className="native-defaults-version">版本 {record.revision}</span>}
      </header>
      <p className="field-help native-defaults-state" id={helpId + '-state'} role="status">
        {busy
          ? '正在保存当前表单，已读默认仍可核对。'
          : error
            ? '项目默认操作未完成，当前表单输入保留。'
            : !record
              ? '正在读取项目默认…'
              : notice}
      </p>
      <p className="field-help" id={helpId + '-scope'}>
        载入会将已保存默认带入当前表单；保存会将当前表单设为项目默认。
        两种操作均不创建任务，执行权限仍由本次任务单独确认。
      </p>
      <div className="native-defaults-comparison">
        {record?.defaults && (
          <details className="native-defaults-summary">
            <summary>
              查看已保存默认配置 <span>v{record.revision}</span>
            </summary>
            <div
              className="native-defaults-reading"
              role="region"
              aria-label="已保存默认完整配置"
              tabIndex={0}
            >
              <DefaultsSummary value={record.defaults} />
            </div>
          </details>
        )}
        <details className="native-defaults-summary">
          <summary>查看当前表单配置</summary>
          <div className="native-defaults-reading" role="region" aria-label="当前表单完整配置" tabIndex={0}>
            <DefaultsSummary value={value} />
          </div>
        </details>
      </div>
      {error && (
        <div className="native-defaults-error" role="alert">
          <p className="native-defaults-reading" role="region" aria-label="项目默认操作问题全文" tabIndex={0}>
            {error}
          </p>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setRetry((v) => v + 1)}
          >
            重新读取
          </button>
        </div>
      )}
      <div className="workflow-actions">
        {record?.defaults && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-describedby={`${helpId}-scope ${helpId}-state`}
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
          aria-describedby={`${helpId}-scope ${helpId}-state`}
          onClick={() => void save()}
        >
          {busy ? '正在保存…' : '保存为项目默认'}
        </button>
      </div>
    </section>
  );
}
