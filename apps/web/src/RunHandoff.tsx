/* 展示并处理运行交接内容。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextPolicy, Project, Run } from '../../../packages/contracts/src/index';
import {
  sourceTextByteLength,
  sourceTextLimitBytes,
  type SourceArtifact,
  type SourceMessage,
  type SourceOptions,
  type RunSourceSnapshot,
} from '../../../packages/contracts/src/workflow';
import type { ModelChoice, SelectableProvider } from './ModelPicker';
import { RunModal, type RunSetupDraft } from './RunSetupModal';
import { Modal } from './Modal';
import { useSurfaceClient } from './SurfaceClientContext';
import { ReviewFeedbackSelection } from './ReviewFeedbackSelection';
import { emptyReviewSource, readReviewSource, reviewNotesIssue } from './ReviewSourceState';
import { ReviewSourceNotes } from './ReviewSourceNotes';
import { useReviewSource } from './useReviewSource';
import { HandoffReviewConfirmation } from './HandoffReviewConfirmation';
import { readArtifactRevision, artifactRevisionIssue } from './ArtifactRevisionDraft';
import { ArtifactRevisionSelection, ArtifactRevisionSummary } from './ArtifactRevisionSelection';
import './workflow.css';
import './run-handoff.css';

function HandoffArtifactDetails({ artifact }: { artifact: SourceArtifact }) {
  // 展示带入产物的版本和完整元数据，供交接前核对来源。
  return (
    <details className="run-handoff-artifact-details">
      <summary>产物完整信息 · v{artifact.version}</summary>
      <dl
        className="run-handoff-reading run-handoff-metadata"
        role="region"
        aria-label="带入产物完整信息"
        tabIndex={0}
      >
        <div>
          <dt>完整名称</dt>
          <dd>{artifact.name}</dd>
        </div>
        <div>
          <dt>产物标识</dt>
          <dd>{artifact.id}</dd>
        </div>
        <div>
          <dt>完整 SHA-256</dt>
          <dd>{artifact.hash}</dd>
        </div>
        <div>
          <dt>格式</dt>
          <dd>{artifact.mediaType}</dd>
        </div>
        <div>
          <dt>核验状态</dt>
          <dd>{artifact.verified ? '证据已核验' : '未核验'}</dd>
        </div>
      </dl>
    </details>
  );
}

type HandoffDraft = {
  projectId: string;
  objective: string;
  feedback: string;
  messages: SourceMessage[];
  artifacts: SourceArtifact[];
  stage: 'select' | 'setup';
  setup?: RunSetupDraft;
  reviewSelection?: unknown;
  artifactRevision?: unknown;
};
/**
 * 容错恢复交接草稿：只保留结构可辨认的公开消息和产物，且各最多 10 项。
 * 该恢复用于表单展示；真正创建任务前仍需核对当前来源、评审指纹和文本字节上限。
 */
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
      reviewSelection: value.reviewSelection,
      artifactRevision: value.artifactRevision,
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

/** 展示已保存的来源快照及原记录入口；此处内容固定于交接时，不随来源任务更新。 */
export function SourceSummary({
  source,
  openSource,
}: {
  source: RunSourceSnapshot;
  openSource?: () => void;
}) {
  return (
    <details className="workflow-source run-handoff-source">
      <summary>来源快照 · 任务修订 {source.runRevision}</summary>
      <p className="run-handoff-reading" role="region" aria-label="快照来源完整标题" tabIndex={0}>
        {source.title}
      </p>
      {openSource && (
        <button type="button" className="text-button" onClick={openSource}>
          打开来源记录
        </button>
      )}
      <p
        className="workflow-prose run-handoff-reading"
        role="region"
        aria-label="来源说明完整内容"
        tabIndex={0}
      >
        {source.feedback}
      </p>
      <p>
        {source.messages.length} 条公开消息 · {source.artifacts.length} 个产物 · {source.capturedAt}
      </p>
      {source.messages.map((message, index) => (
        <details key={message.id}>
          <summary>
            {message.role === 'user' ? '用户' : '助手'} · {message.text.slice(0, 60)}
          </summary>
          <p
            className="workflow-prose run-handoff-reading"
            role="region"
            aria-label={`来源消息 ${index + 1} 完整正文`}
            tabIndex={0}
          >
            {message.text}
          </p>
        </details>
      ))}
      {source.artifacts.map((artifact) => (
        <div className="run-handoff-artifact" key={artifact.id}>
          <p className="run-handoff-reading" role="region" aria-label="来源产物完整名称" tabIndex={0}>
            {artifact.name}
          </p>
          <HandoffArtifactDetails artifact={artifact} />
        </div>
      ))}
      {!!source.reviewNotes?.length && (
        <ReviewSourceNotes notes={source.reviewNotes} sourceRunId={source.runId} />
      )}
      {!!source.artifactChanges?.length && <ArtifactRevisionSummary items={source.artifactChanges} />}
      <details>
        <summary>来源快照校验信息</summary>
        <p className="run-handoff-reading" role="region" aria-label="来源快照完整哈希" tabIndex={0}>
          SHA256 {source.hash}
        </p>
      </details>
    </details>
  );
}

/**
 * 将当前运行的明确公开内容选入新项目任务，分“选来源”和“设本次权限/预算”两阶段。
 * 消息和产物可跨页选择，复核备注及差异必须匹配最新来源指纹；未添加的待处理选择需
 * 用户明确忽略后才能进入创建阶段，防止把未核对内容隐式带入后续任务。
 */
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
  reviewDraft,
  backToReview,
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
  reviewDraft?: unknown;
  backToReview?: () => void;
}) {
  const { api } = useSurfaceClient();
  const draft = useMemo(() => readDraft(value, run), [value, run.id]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /**
   * 使用最新 ref 合并局部草稿并在上限内完整序列化；超限整次拒绝而不截断已有来源文本。
   * 来源选择或阶段退回改变后，撤销对“忽略尚未加入条目”的旧确认。
   */
  const patch = (next: Partial<HandoffDraft>) => {
    const updated = { ...draftRef.current, ...next };
    const raw = JSON.stringify(updated);
    if (raw.length > 200000) {
      setDraftIssue('交接草稿已达到本机保存上限，本次修改未写入。请先移除不再需要的待选或已加入内容。');
      return;
    }
    setDraftIssue('');
    if (next.reviewSelection !== undefined || next.artifactRevision !== undefined || next.stage === 'select')
      setIgnoredPending(undefined);
    draftRef.current = updated;
    change(raw);
  };
  const [draftIssue, setDraftIssue] = useState('');
  const [ignoredPending, setIgnoredPending] = useState<string>();
  const [options, setOptions] = useState<SourceOptions>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState('');
  const [messageIssue, setMessageIssue] = useState('');
  const messageRequest = useRef<AbortController | null>(null);
  useEffect(() => () => messageRequest.current?.abort(), [run.id]);
  const [retry, setRetry] = useState(0);
  const reviewSource = useReviewSource(
    run.id,
    run.kind === 'task' && run.status === 'DONE',
    run.revision,
    draft.stage,
    retry,
  );
  const reviewSelection = readReviewSource(draft.reviewSelection);
  const reviewNotes = reviewSelection?.added || [];
  const pendingNotes = reviewSelection?.pending || [];
  const artifactRevision = readArtifactRevision(draft.artifactRevision);
  const differences = artifactRevision?.filter((entry) => entry.added) || [];
  const pendingDifferences = artifactRevision?.filter((entry) => !entry.added) || [];
  const differencesIssue = artifactRevision
    ? artifactRevisionIssue(artifactRevision)
    : '差异草稿格式无法读取，请返回选择页处理。';
  // 已添加差异与复核备注不仅要求读取成功，还必须与当前来源指纹一致。
  const differencesReady =
    !differences.length ||
    (!!reviewSource.value &&
      !reviewSource.reading &&
      !reviewSource.error &&
      differences.every((entry) => entry.fingerprint === reviewSource.value!.fingerprint));
  const pendingKey = JSON.stringify([pendingNotes, pendingDifferences]);
  const pendingReady = (!pendingNotes.length && !pendingDifferences.length) || ignoredPending === pendingKey;
  const notesIssue = reviewSelection
    ? reviewNotesIssue(reviewNotes)
    : '备注选择草稿格式无法读取，请返回选择页处理。';
  const notesReady =
    !reviewNotes.length ||
    (!!reviewSource.value &&
      !reviewSource.reading &&
      !reviewSource.error &&
      reviewSelection?.fingerprint === reviewSource.value.fingerprint);
  const [messageBefore, setMessageBefore] = useState('');
  const [artifactBefore, setArtifactBefore] = useState('');
  const selectedProject = projects.find((project) => project.id === draft.projectId && !project.archived);
  // 来源消息和产物各有独立游标，但一次响应原子替换 options；旧请求取消后不能写入新页。
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
  const selectedBytes = sourceTextByteLength(draft.messages, draft.feedback);
  // 目标项目、明确说明、至少一项来源与总字节限制共同决定是否允许进入任务设置。
  const canContinue =
    !!selectedProject &&
    !!draft.objective.trim() &&
    (!!draft.feedback.trim() || reviewNotes.length > 0 || differences.length > 0) &&
    !!options &&
    !error &&
    !loading &&
    selectedBytes <= sourceTextLimitBytes &&
    !notesIssue &&
    !differencesIssue &&
    differencesReady &&
    notesReady &&
    draft.messages.length + draft.artifacts.length + reviewNotes.length + differences.length > 0;
  const selectionPreview = (
    <section className="workflow-source run-handoff-source" aria-label="带入内容预览">
      <strong>带入内容预览</strong>
      <p className="run-handoff-reading" role="region" aria-label="交接来源完整标题" tabIndex={0}>
        {run.title || run.objective}
      </p>
      <p
        className="workflow-prose run-handoff-reading"
        role="region"
        aria-label="已选交接说明完整内容"
        tabIndex={0}
      >
        {draft.feedback}
      </p>
      <p>
        {draft.messages.length} 条公开消息 · {draft.artifacts.length} 个产物 · {reviewNotes.length} 条复核备注
      </p>
      {draft.messages.map((message, index) => (
        <details key={message.id}>
          <summary>
            {message.role === 'user' ? '用户' : '助手'} · {message.text.slice(0, 70)}
          </summary>
          <p
            className="workflow-prose run-handoff-reading"
            role="region"
            aria-label={`已选消息 ${index + 1} 完整正文`}
            tabIndex={0}
          >
            {message.text}
          </p>
        </details>
      ))}
      {!!reviewNotes.length && <ReviewSourceNotes notes={reviewNotes} />}
      {!!differences.length && <ArtifactRevisionSummary items={differences} />}
      {draft.artifacts.map((artifact) => (
        <div className="run-handoff-artifact" key={artifact.id}>
          <p className="run-handoff-reading" role="region" aria-label="已选产物完整名称" tabIndex={0}>
            {artifact.name}
          </p>
          <HandoffArtifactDetails artifact={artifact} />
        </div>
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
            <HandoffReviewConfirmation
              added={reviewNotes.length}
              pending={pendingNotes.length}
              addedDifferences={differences.length}
              pendingDifferences={pendingDifferences.length}
              ignored={pendingReady}
              disabled={busy}
              ignore={(ignored) => setIgnoredPending(ignored ? pendingKey : undefined)}
              back={() => patch({ stage: 'select' })}
            />
            <details className="workflow-source">
              <summary>
                已确认的带入内容（{draft.messages.length} 条消息、{draft.artifacts.length} 个产物、
                {reviewNotes.length} 条备注）
              </summary>
              {selectionPreview}
            </details>
            {error && (
              <div className="run-handoff-feedback" role="alert">
                <p
                  className="field-error workflow-read-error run-handoff-reading"
                  role="region"
                  aria-label="交接来源读取问题全文"
                  tabIndex={0}
                >
                  {error}
                </p>
                <button type="button" className="secondary" onClick={() => setRetry((v) => v + 1)}>
                  重新读取来源
                </button>
              </div>
            )}
            {loading && <p role="status">正在核对来源记录…</p>}
            {draftIssue && (
              <p role="alert" className="field-error">
                {draftIssue}
              </p>
            )}
            {notesIssue && (
              <p role="alert" className="field-error">
                {notesIssue}
              </p>
            )}
            {differencesIssue && (
              <p role="alert" className="field-error">
                {differencesIssue}
              </p>
            )}
            {!!differences.length && !differencesReady && (
              <p role="alert" className="field-error">
                差异的来源交付尚未确认。输入保留，请返回核对最新差异后重新加入。
              </p>
            )}
            {!!reviewNotes.length && !notesReady && (
              <p role="alert" className="field-error">
                {reviewSource.reading
                  ? '正在核对所选备注的来源交付…'
                  : reviewSource.error ||
                    '来源交付版本已变化。备注与任务配置均已保留，请返回调整带入内容并明确重新确认。'}
              </p>
            )}
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
        submitDisabled={!canContinue || !pendingReady}
        settings={settings}
        submit={(body) => {
          if (!canContinue || !pendingReady || busy) return;
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
              reviewNotes,
              artifactChanges: differences.map((entry) => ({
                reviewId: entry.reviewId,
                artifactId: entry.change.artifactId,
                requirement: entry.requirement,
              })),
              ...(reviewNotes.length || differences.length
                ? { expectedDeliveryFingerprint: reviewSource.value!.fingerprint }
                : {}),
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
      className="workflow-modal run-handoff-modal"
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
          {draftIssue && (
            <p role="alert" className="field-error">
              {draftIssue}
            </p>
          )}
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
          {run.kind === 'task' && run.status === 'DONE' && (
            <ReviewFeedbackSelection
              runId={run.id}
              localDraft={reviewDraft}
              value={reviewSource.value}
              reading={reviewSource.reading}
              error={reviewSource.error}
              retry={() => setRetry((value) => value + 1)}
              selection={draft.reviewSelection}
              change={(reviewSelection) => patch({ reviewSelection })}
              disabled={busy}
            />
          )}
          <ArtifactRevisionSelection
            runId={run.id}
            raw={draft.artifactRevision}
            change={(artifactRevision) => patch({ artifactRevision })}
            fingerprint={reviewSource.value?.fingerprint}
            disabled={busy || reviewSource.reading || !!reviewSource.error}
            reload={() => setRetry((value) => value + 1)}
          />
          <p className="field-help">
            每类最多选择 10 项。当前已选 {draft.messages.length} 条消息、{draft.artifacts.length} 个产物。
            消息正文与修改意见合计 {selectedBytes.toLocaleString()} / {sourceTextLimitBytes.toLocaleString()}{' '}
            字节（UTF-8，最多 16 KiB）。
          </p>
          {error && (
            <div className="run-handoff-feedback" role="alert">
              <p
                className="field-error workflow-read-error run-handoff-reading"
                role="region"
                aria-label="交接来源读取问题全文"
                tabIndex={0}
              >
                {error}
              </p>
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => setRetry((v) => v + 1)}
              >
                重新读取来源
              </button>
            </div>
          )}
          {selectedBytes > sourceTextLimitBytes && (
            <p className="field-error" role="alert">
              消息正文与修改意见合计超过 16 KiB，请减少选择或精简意见。
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
                {options.messages.map((message, index) => {
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
                        <pre
                          className="run-handoff-reading"
                          role="region"
                          aria-label={`待选消息 ${index + 1} 完整正文`}
                          tabIndex={0}
                        >
                          {message.text}
                        </pre>
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
                <nav className="workflow-pagination" aria-label="来源消息分页">
                  <span className="workflow-pagination-summary">本页 {options.messages.length} 条消息</span>
                  <div className="workflow-pagination-actions">
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
                </nav>
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
                      <HandoffArtifactDetails artifact={artifact} />
                    </div>
                  );
                })}
                {!options.artifacts.length && <p className="field-help">此页没有登记产物。</p>}
                <nav className="workflow-pagination" aria-label="来源产物分页">
                  <span className="workflow-pagination-summary">本页 {options.artifacts.length} 个产物</span>
                  <div className="workflow-pagination-actions">
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
                </nav>
              </fieldset>
            </>
          )}
          {loading && <p role="status">正在读取来源…</p>}
          {(draft.messages.length > 0 ||
            draft.artifacts.length > 0 ||
            reviewNotes.length > 0 ||
            differences.length > 0) && (
            <>
              {selectionPreview}
              <div className="workflow-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    patch({
                      messages: [],
                      artifacts: [],
                      reviewSelection: emptyReviewSource(),
                      artifactRevision: [],
                    })
                  }
                >
                  清空所选内容
                </button>
              </div>
            </>
          )}
        </div>
        <footer className="modal-footer">
          {backToReview && (
            <button type="button" className="secondary" onClick={backToReview} disabled={busy}>
              返回复核，保留草稿
            </button>
          )}
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
