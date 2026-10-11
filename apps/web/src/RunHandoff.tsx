import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextPolicy, Project, Run } from '../../../packages/contracts/src/index';
import type {
  SourceArtifact,
  SourceMessage,
  SourceOptions,
  RunSourceSnapshot,
} from '../../../packages/contracts/src/workflow';
import type { ModelChoice, SelectableProvider } from './ModelPicker';
import { RunModal, type RunSetupDraft } from './RunSetupModal';
import { Modal } from './Modal';
import { useSurfaceClient } from './SurfaceClientContext';
import './workflow.css';

type HandoffDraft = {
  projectId: string;
  objective: string;
  feedback: string;
  messages: SourceMessage[];
  artifacts: SourceArtifact[];
  stage: 'select' | 'setup';
  setup?: RunSetupDraft;
};
function readDraft(raw: unknown, run: Run): HandoffDraft {
  const empty: HandoffDraft = {
    projectId: run.projectId || '',
    objective: run.objective,
    feedback: '',
    messages: [],
    artifacts: [],
    stage: 'select',
  };
  if (typeof raw !== 'string' || !raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return empty;
    return {
      ...empty,
      projectId: typeof value.projectId === 'string' ? value.projectId : empty.projectId,
      objective: typeof value.objective === 'string' ? value.objective : empty.objective,
      feedback: typeof value.feedback === 'string' ? value.feedback : '',
      messages: Array.isArray(value.messages)
        ? value.messages
            .filter(
              (item: SourceMessage) =>
                item &&
                typeof item.id === 'string' &&
                typeof item.text === 'string' &&
                ['user', 'assistant'].includes(item.role),
            )
            .slice(0, 10)
        : [],
      artifacts: Array.isArray(value.artifacts)
        ? value.artifacts
            .filter(
              (item: SourceArtifact) =>
                item &&
                typeof item.id === 'string' &&
                typeof item.hash === 'string' &&
                typeof item.name === 'string',
            )
            .slice(0, 10)
        : [],
      stage: value.stage === 'setup' ? 'setup' : 'select',
      setup:
        value.setup?.choice && value.setup?.contextPolicy && value.setup?.terminalProfile
          ? value.setup
          : undefined,
    };
  } catch {
    return empty;
  }
}

export function SourceSummary({
  source,
  openSource,
}: {
  source: RunSourceSnapshot;
  openSource?: () => void;
}) {
  return (
    <details className="workflow-source">
      <summary>来源 · {source.title}</summary>
      {openSource && (
        <button type="button" className="text-button" onClick={openSource}>
          打开来源记录
        </button>
      )}
      <p className="workflow-prose">{source.feedback}</p>
      <p>
        {source.messages.length} 条公开消息 · {source.artifacts.length} 个产物 · {source.capturedAt}
      </p>
      {source.messages.map((message) => (
        <details key={message.id}>
          <summary>
            {message.role === 'user' ? '用户' : '助手'} · {message.text.slice(0, 60)}
          </summary>
          <p className="workflow-prose">{message.text}</p>
        </details>
      ))}
      {source.artifacts.map((artifact) => (
        <p key={artifact.id}>
          {artifact.name} · v{artifact.version} · SHA256 {artifact.hash.slice(0, 12)}
        </p>
      ))}
      <small>来源快照 SHA256 {source.hash}</small>
    </details>
  );
}

export function RunHandoff({
  run,
  projects,
  providers,
  modelChoice,
  contextPolicy,
  value,
  change,
  close,
  submit,
  settings,
  busy,
}: {
  run: Run;
  projects: Project[];
  providers: SelectableProvider[];
  modelChoice: ModelChoice;
  contextPolicy: ContextPolicy;
  value: unknown;
  change: (value: string) => void;
  close: () => void;
  submit: (body: Record<string, unknown>) => void;
  settings: () => void;
  busy: boolean;
}) {
  const { api } = useSurfaceClient();
  const draft = useMemo(() => readDraft(value, run), [value, run.id]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const patch = (next: Partial<HandoffDraft>) => {
    draftRef.current = { ...draftRef.current, ...next };
    change(JSON.stringify(draftRef.current));
  };
  const [options, setOptions] = useState<SourceOptions>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState('');
  const [messageIssue, setMessageIssue] = useState('');
  const messageRequest = useRef<AbortController | null>(null);
  useEffect(() => () => messageRequest.current?.abort(), [run.id]);
  const [retry, setRetry] = useState(0);
  const [messageBefore, setMessageBefore] = useState('');
  const [artifactBefore, setArtifactBefore] = useState('');
  const selectedProject = projects.find((project) => project.id === draft.projectId && !project.archived);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const query = new URLSearchParams();
    if (messageBefore) query.set('beforeMessage', messageBefore);
    if (artifactBefore) query.set('beforeArtifact', artifactBefore);
    void api<SourceOptions>(`/runs/${run.id}/handoff?${query}`, undefined, undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setOptions(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '来源读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, run.id, messageBefore, artifactBefore, retry]);
  const selectedBytes = new TextEncoder().encode(
    draft.feedback + draft.messages.map((message) => message.text).join('\n'),
  ).length;
  const canContinue =
    !!selectedProject &&
    !!draft.objective.trim() &&
    !!draft.feedback.trim() &&
    !!options &&
    !error &&
    !loading &&
    selectedBytes <= 16384 &&
    draft.messages.length + draft.artifacts.length > 0;
  const selectionPreview = (
    <section className="workflow-source" aria-label="带入内容预览">
      <strong>带入内容预览 · {run.title || run.objective}</strong>
      <p className="workflow-prose">{draft.feedback}</p>
      <p>
        {draft.messages.length} 条公开消息 · {draft.artifacts.length} 个产物
      </p>
      {draft.messages.map((message) => (
        <details key={message.id}>
          <summary>
            {message.role === 'user' ? '用户' : '助手'} · {message.text.slice(0, 70)}
          </summary>
          <p className="workflow-prose">{message.text}</p>
        </details>
      ))}
      {draft.artifacts.map((artifact) => (
        <p key={artifact.id}>
          {artifact.name} · v{artifact.version} · SHA256 {artifact.hash.slice(0, 12)}
        </p>
      ))}
      <p className="field-help">按所选公开内容建立来源快照。请重新确认目标项目、本次权限与预算。</p>
    </section>
  );
  if (draft.stage === 'setup' && selectedProject)
    return (
      <RunModal
        key={selectedProject.id}
        objective={draft.objective}
        kind="task"
        projectId={selectedProject.id}
        projectName={selectedProject.name}
        providers={providers}
        modelChoice={modelChoice}
        contextPolicy={contextPolicy}
        initial={draft.setup}
        changed={(setup) => patch({ setup })}
        beforeForm={
          <>
            {selectionPreview}
            {error && (
              <p className="field-error" role="alert">
                {error}{' '}
                <button type="button" onClick={() => setRetry((v) => v + 1)}>
                  重新读取来源
                </button>
              </p>
            )}
            {loading && <p role="status">正在核对来源记录…</p>}
            <div className="workflow-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => patch({ stage: 'select' })}
              >
                调整带入内容
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy || loading}
                onClick={() => setRetry((v) => v + 1)}
              >
                重新读取来源
              </button>
            </div>
          </>
        }
        close={() => patch({ stage: 'select' })}
        busy={busy}
        submitDisabled={!canContinue}
        settings={settings}
        submit={(body) => {
          if (!canContinue || busy) return;
          submit({
            ...body,
            objective: draft.objective,
            kind: 'task',
            projectId: selectedProject.id,
            source: {
              runId: run.id,
              expectedRevision: options!.runRevision,
              messageIds: draft.messages.map((message) => message.id),
              artifacts: draft.artifacts.map(({ id, version, hash }) => ({ id, version, hash })),
              feedback: draft.feedback,
            },
          });
        }}
      />
    );
  return (
    <Modal
      title={run.kind === 'chat' ? '在项目中执行' : '提出修改'}
      subtitle="选择带入内容，再确认本次任务配置"
      close={close}
      busy={busy}
      wide
      className="workflow-modal"
    >
      <form
        className="workflow-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue && !busy) patch({ stage: 'setup' });
        }}
      >
        <div className="form-body workflow-body">
          <label>
            目标项目
            <select
              aria-label="交接目标项目"
              value={draft.projectId}
              disabled={busy}
              onChange={(event) => patch({ projectId: event.target.value, setup: undefined })}
            >
              <option value="">请选择项目</option>
              {draft.projectId && !selectedProject && (
                <option value={draft.projectId} disabled>
                  原项目不可用，请重新选择
                </option>
              )}
              {projects
                .filter((project) => !project.archived)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
          {!projects.some((project) => !project.archived) && (
            <p className="field-help">请先关闭此窗口并创建项目，带入内容草稿会保留。</p>
          )}
          <label>
            新任务目标
            <textarea
              aria-label="新任务目标"
              value={draft.objective}
              disabled={busy}
              maxLength={20000}
              rows={2}
              onChange={(event) => patch({ objective: event.target.value })}
            />
          </label>
          <label>
            {run.kind === 'chat' ? '执行说明' : '修改意见'}
            <textarea
              aria-label="交接说明"
              value={draft.feedback}
              disabled={busy}
              maxLength={4000}
              rows={3}
              placeholder="说明本次要做什么、保留什么，以及如何验收…"
              onChange={(event) => patch({ feedback: event.target.value })}
            />
          </label>
          <p className="field-help">
            每类最多选择 10 项；消息总量最多 16 KiB。当前已选 {draft.messages.length} 条消息、
            {draft.artifacts.length} 个产物。
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}{' '}
              <button type="button" disabled={loading} onClick={() => setRetry((v) => v + 1)}>
                重新读取来源
              </button>
            </p>
          )}
          {selectedBytes > 16384 && (
            <p className="field-error" role="alert">
              选定消息超过 16 KiB，请减少选择。
            </p>
          )}
          {messageIssue && (
            <p className="field-error" role="alert">
              {messageIssue}
            </p>
          )}
          {options && (
            <>
              <fieldset>
                <legend>选择公开消息</legend>
                {options.messages.map((message) => {
                  const selected = draft.messages.some((item) => item.id === message.id);
                  return (
                    <div className="workflow-selection" key={message.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={busy || message.truncated || (!selected && draft.messages.length >= 10)}
                          onChange={() =>
                            patch({
                              messages: selected
                                ? draft.messages.filter((item) => item.id !== message.id)
                                : [...draft.messages, message],
                            })
                          }
                        />
                        <span>
                          {message.role === 'user' ? '用户' : '助手'} · {message.text.slice(0, 120)}
                          {message.truncated ? '（请先读取完整消息）' : ''}
                        </span>
                      </label>
                      <details>
                        <summary>预览消息</summary>
                        <pre>{message.text}</pre>
                        {message.truncated && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy || !!messageLoading}
                            onClick={() => {
                              messageRequest.current?.abort();
                              const controller = new AbortController();
                              messageRequest.current = controller;
                              setMessageLoading(message.id);
                              setMessageIssue('');
                              void api<SourceMessage>(
                                `/runs/${run.id}/handoff/messages/${message.id}`,
                                undefined,
                                undefined,
                                controller.signal,
                              )
                                .then((full) => {
                                  if (controller.signal.aborted) return;
                                  setOptions((old) =>
                                    old
                                      ? {
                                          ...old,
                                          messages: old.messages.map((item) =>
                                            item.id === full.id ? full : item,
                                          ),
                                        }
                                      : old,
                                  );
                                  if (full.truncated)
                                    setMessageIssue(
                                      '此消息超过 16 KiB，无法完整带入。请选较短消息，并在执行说明中概括所需内容。',
                                    );
                                })
                                .catch((issue) => {
                                  if (!controller.signal.aborted)
                                    setMessageIssue(
                                      issue instanceof Error ? issue.message : '完整消息读取失败。',
                                    );
                                })
                                .finally(() => {
                                  if (!controller.signal.aborted) setMessageLoading('');
                                });
                            }}
                          >
                            {messageLoading === message.id ? '正在读取…' : '读取完整消息'}
                          </button>
                        )}
                      </details>
                    </div>
                  );
                })}
                {!options.messages.length && <p className="field-help">此页没有可选择的公开消息。</p>}
                <div className="workflow-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading || !messageBefore}
                    onClick={() => setMessageBefore('')}
                  >
                    最新消息
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading || !options.messagePage.hasMore}
                    onClick={() => setMessageBefore(options.messagePage.nextBefore!)}
                  >
                    更早消息
                  </button>
                </div>
              </fieldset>
              <fieldset>
                <legend>选择产物版本</legend>
                {options.artifacts.map((artifact) => {
                  const selected = draft.artifacts.some((item) => item.id === artifact.id);
                  return (
                    <div className="workflow-selection" key={artifact.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={busy || (!selected && draft.artifacts.length >= 10)}
                          onChange={() =>
                            patch({
                              artifacts: selected
                                ? draft.artifacts.filter((item) => item.id !== artifact.id)
                                : [...draft.artifacts, artifact],
                            })
                          }
                        />
                        <span>
                          {artifact.name} · v{artifact.version} ·{' '}
                          {artifact.verified ? '证据已核验' : '未核验'}
                          <br />
                          <small>SHA256 {artifact.hash.slice(0, 12)}</small>
                        </span>
                      </label>
                    </div>
                  );
                })}
                {!options.artifacts.length && <p className="field-help">此页没有登记产物。</p>}
                <div className="workflow-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading || !artifactBefore}
                    onClick={() => setArtifactBefore('')}
                  >
                    最新产物
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading || !options.artifactPage.hasMore}
                    onClick={() => setArtifactBefore(options.artifactPage.nextBefore!)}
                  >
                    更早产物
                  </button>
                </div>
              </fieldset>
            </>
          )}
          {loading && <p role="status">正在读取来源…</p>}
          {(draft.messages.length > 0 || draft.artifacts.length > 0) && (
            <>
              {selectionPreview}
              <div className="workflow-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => patch({ messages: [], artifacts: [] })}
                >
                  清空所选内容
                </button>
              </div>
            </>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            关闭并保留草稿
          </button>
          <button className="primary" disabled={busy || !canContinue}>
            确认内容，设置任务
          </button>
        </footer>
      </form>
    </Modal>
  );
}
