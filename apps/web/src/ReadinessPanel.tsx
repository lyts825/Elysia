/* 展示应用准备状态及引导操作。 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  ReadinessSnapshot,
  type ReadinessAction,
  type ReadinessCheck,
} from '../../../packages/contracts/src/readiness';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import './readiness.css';

const statuses: Record<ReadinessCheck['status'], string> = {
  recorded: '已有记录',
  missing: '待配置',
  review: '待核对',
  unknown: '未检测',
  optional: '可选',
};
const actions: Record<ReadinessAction['kind'], string> = {
  models: '管理模型连接',
  'new-project': '打开项目',
  projects: '管理项目',
  'terminal-apps': '打开终端应用',
  'terminal-connections': '管理终端连接',
  'terminal-project': '管理项目默认',
  'terminal-templates': '管理终端模板',
};
export interface ReadinessPanelProps {
  projectId?: string;
  close: () => void;
  repair: (action: ReadinessAction) => void;
}
export function ReadinessPanel(props: ReadinessPanelProps) {
  const { surface } = useSurfaceClient();
  return <ReadinessContent key={`${surface}:${props.projectId ?? ''}`} {...props} />;
}
function ReadinessContent({ projectId, close, repair }: ReadinessPanelProps) {
  const { api, surface } = useSurfaceClient();
  const identity = useId();
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false);
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [errorFocus, setErrorFocus] = useState(0);
  useEffect(() => {
    if (!errorFocus) return;
    errorRef.current?.focus({ preventScroll: true });
    errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [errorFocus]);
  const load = async (focusFailure = false) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    setStale(true);
    try {
      const result = ReadinessSnapshot.parse(
        await api(
          '/readiness' + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''),
          undefined,
          undefined,
          request.signal,
        ),
      );
      if (request.signal.aborted || !mounted.current) return;
      if (result.surface !== surface || result.projectId !== (projectId ?? null))
        throw Error('检查结果与当前入口或项目不一致，请重新读取。');
      setSnapshot(result);
      setStale(false);
    } catch (issue) {
      if (!request.signal.aborted && mounted.current) {
        setError(
          issue instanceof Error && issue.name !== 'ZodError' ? issue.message : '检查结果无法读取，请重试。',
        );
        if (focusFailure) setErrorFocus((value) => value + 1);
      }
    } finally {
      if (!request.signal.aborted && mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [api, projectId, surface]);
  const cancel = () => {
    controller.current?.abort();
    setLoading(false);
    setStale(true);
    setError('读取已取消。已显示的检查记录保留，可重新读取。');
    setErrorFocus((value) => value + 1);
  };
  const follow = (action: ReadinessAction) => {
    try {
      repair(action);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '无法打开设置，请重试。');
      setErrorFocus((value) => value + 1);
    }
  };
  const needsAttention =
    snapshot?.checks.filter((check) => ['missing', 'review'].includes(check.status)).length ?? 0;
  return (
    <Modal
      title="使用前检查"
      subtitle={surface === 'terminal' ? 'Agent 终端 · 本机配置记录' : 'Elysia 原生 · 本机配置记录'}
      close={close}
      className="readiness-modal"
    >
      <div className="readiness-body">
        <p className="field-help">
          这里只整理已保存的配置和验证记录，不读取凭据、不调用模型。已有记录不代表当前可以执行。
        </p>
        <div className="readiness-toolbar">
          <button type="button" className="secondary" onClick={() => void load(true)} disabled={loading}>
            {loading ? '正在读取…' : '重新读取检查'}
          </button>
          {loading && (
            <button type="button" className="text-button" onClick={cancel}>
              取消读取
            </button>
          )}
          {snapshot && (
            <span role="status">
              {stale
                ? `保留上次已读 ${snapshot.checks.length} 项记录`
                : `本次已读 ${snapshot.checks.length} 项记录 · ${needsAttention} 项需要配置或核对`}
            </span>
          )}
        </div>
        {error && (
          <p
            className="readiness-error"
            role="alert"
            aria-label="使用前检查问题全文"
            ref={errorRef}
            tabIndex={0}
          >
            {error}
          </p>
        )}
        {!snapshot && !loading && <p className="field-help">尚未获得检查记录；读取失败不代表配置缺失。</p>}
        {snapshot && (
          <>
            <p className="readiness-time">
              {stale ? '上次记录生成于' : '检查记录生成于'} {new Date(snapshot.checkedAt).toLocaleString()} ·
              v{snapshot.appVersion}
            </p>
            <details className="readiness-origin">
              <summary>检查范围与记录来源</summary>
              <dl
                className="readiness-record-reading"
                role="region"
                tabIndex={0}
                aria-label="使用前检查完整范围与来源"
              >
                <div>
                  <dt>所属入口</dt>
                  <dd>{snapshot.surface === 'terminal' ? 'Agent 终端' : 'Elysia 原生'}</dd>
                </div>
                <div>
                  <dt>项目范围</dt>
                  <dd>{snapshot.projectId || '未指定项目，按当前入口整理记录'}</dd>
                </div>
                <div>
                  <dt>生成时间原值</dt>
                  <dd>{snapshot.checkedAt}</dd>
                </div>
                <div>
                  <dt>程序版本</dt>
                  <dd>{snapshot.appVersion}</dd>
                </div>
              </dl>
            </details>
            <ul className="readiness-list">
              {snapshot.checks.map((check, index) => (
                <li key={check.id} data-status={check.status}>
                  <div className="readiness-row-head">
                    <h3 id={`${identity}-check-${index}`}>{check.title}</h3>
                    <span className="readiness-badge">{statuses[check.status]}</span>
                  </div>
                  <p
                    className="readiness-record-reading"
                    role="region"
                    tabIndex={0}
                    aria-label={`${check.title}完整检查说明`}
                  >
                    {check.detail}
                  </p>
                  <details className="readiness-origin">
                    <summary>检查条目标识与管理目标</summary>
                    <dl
                      className="readiness-record-reading"
                      role="region"
                      tabIndex={0}
                      aria-label={`${check.title}完整检查来源`}
                    >
                      <div>
                        <dt>检查条目标识</dt>
                        <dd>{check.id}</dd>
                      </div>
                      <div>
                        <dt>管理入口</dt>
                        <dd>{check.action ? actions[check.action.kind] : '当前记录未提供管理入口'}</dd>
                      </div>
                      {check.action && (
                        <div>
                          <dt>目标标识</dt>
                          <dd>{check.action.targetId || '未指定具体条目'}</dd>
                        </div>
                      )}
                    </dl>
                  </details>
                  {check.action && (
                    <button
                      type="button"
                      className="text-button"
                      aria-describedby={`${identity}-check-${index}`}
                      onClick={() => follow(check.action!)}
                    >
                      {actions[check.action.kind]}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary" onClick={close}>
          关闭
        </button>
      </footer>
    </Modal>
  );
}
