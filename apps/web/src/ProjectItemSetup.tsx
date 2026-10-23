import { useId, useRef, useState } from 'react';
import type { ContextPolicy } from '../../../packages/contracts/src/index';
import { RunModal } from './RunSetupModal';
import { readRunSetupDraft, writeRunSetupDraft, type RunSetupDraft } from './RunSetupDraft';
import type { SelectableProvider, ModelChoice } from './ModelPicker';
import {
  projectBoardKey,
  readProjectBoardDraft,
  writeProjectBoardDraft,
  type ProjectBoardDraft,
} from './ProjectBoardDraft';
import type { WorkbenchCache } from './WorkbenchCache';
import { Modal } from './Modal';
import './project-item-setup.css';

export function ProjectItemSetup({
  projectId,
  projectName,
  cache,
  providers,
  modelChoice,
  contextPolicy,
  close,
  settings,
  submit,
  busy,
}: {
  projectId: string;
  projectName: string;
  cache: WorkbenchCache;
  providers: SelectableProvider[];
  modelChoice: ModelChoice;
  contextPolicy: ContextPolicy;
  busy: boolean;
  close: () => void;
  settings: () => void;
  submit: (body: Record<string, unknown>, launch: NonNullable<ProjectBoardDraft['launch']>) => void;
}) {
  const headingId = useId(),
    objectiveHelpId = useId();
  const [error, setError] = useState('');
  const first = useRef<
    { launch?: ProjectBoardDraft['launch']; initial?: RunSetupDraft; error?: string } | undefined
  >(undefined);
  if (!first.current) {
    try {
      const launch = readProjectBoardDraft(cache.get(projectBoardKey(projectId))).launch;
      first.current = { launch, initial: readRunSetupDraft(launch?.setupRaw) };
    } catch (issue) {
      first.current = { error: issue instanceof Error ? issue.message : '创建草稿无法读取' };
    }
  }
  const [objective, setObjective] = useState(first.current.launch?.objective || '');
  const launch = first.current.launch;
  const lastSaved = useRef(launch);
  const saveLaunch = (patch: Partial<NonNullable<ProjectBoardDraft['launch']>>) => {
    const current = readProjectBoardDraft(cache.get(projectBoardKey(projectId))).launch;
    if (!launch || !current || JSON.stringify(current) !== JSON.stringify(lastSaved.current))
      throw Error('创建来源草稿已变化或移除，请返回项目工作台核对。当前表单仍保留。');
    const next = { ...current, ...patch };
    writeProjectBoardDraft(cache, projectId, (value) => ({ ...value, launch: next }));
    // Compare normalized persisted shapes: adding setupRaw can change object key order.
    lastSaved.current = readProjectBoardDraft(cache.get(projectBoardKey(projectId))).launch;
    return lastSaved.current;
  };
  const save = (setup: RunSetupDraft): NonNullable<ProjectBoardDraft['launch']> | undefined => {
    try {
      const raw = writeRunSetupDraft(setup);
      const next = saveLaunch({ objective, setupRaw: raw });
      setError('');
      return next;
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '创建草稿保存失败');
    }
  };
  if (first.current.error || !launch)
    return (
      <Modal title="从交付项创建任务" close={close}>
        <div className="form-body project-item-setup-error">
          <p
            className="field-error project-item-setup-reading"
            role="alert"
            tabIndex={0}
            aria-label="交付项创建草稿读取错误全文"
          >
            {first.current.error || '没有可用的交付项创建草稿，请返回项目工作台。'}
          </p>
        </div>
      </Modal>
    );
  return (
    <RunModal
      providers={providers}
      objective={objective}
      kind="task"
      projectId={projectId}
      projectName={projectName}
      initial={first.current.initial}
      initialRequirements={{
        deliverables: launch.deliverables,
        acceptanceCriteria: launch.acceptanceCriteria,
      }}
      modelChoice={modelChoice}
      contextPolicy={contextPolicy}
      close={close}
      busy={busy}
      changed={(setup) => {
        save(setup);
      }}
      submitDisabled={!objective.trim() || !!error}
      beforeForm={
        <section className="project-item-setup" aria-labelledby={headingId}>
          <h3 id={headingId}>从交付项创建</h3>
          <p className="field-help">来源交付项</p>
          <p
            className="project-item-setup-reading project-item-setup-title"
            role="region"
            tabIndex={0}
            aria-label="来源交付项完整名称"
          >
            {launch.title}
          </p>
          <dl className="project-item-setup-versions">
            <div>
              <dt>来源项目计划</dt>
              <dd>版本 {launch.expectedRevision}</dd>
            </div>
            <div>
              <dt>来源交付项标准</dt>
              <dd>版本 {launch.itemRevision}</dd>
            </div>
          </dl>
          <p className="field-help">
            核对目标、交付物、权限与预算后明确创建。允许调整本次执行要求；创建只关联为候选，不代表已符合项目标准。
          </p>
          {first.current.initial && (
            <p className="field-help project-item-setup-restored" role="status">
              已恢复上次保存的创建配置。本次交付物和验收标准采用下方表单中的保留值，可继续编辑；不会自动替换为项目标准。
            </p>
          )}
          <label className="project-item-setup-objective">
            本次任务目标
            <textarea
              value={objective}
              maxLength={20000}
              rows={5}
              aria-describedby={objectiveHelpId}
              onChange={(e) => {
                const value = e.target.value;
                setObjective(value);
                try {
                  saveLaunch({ objective: value });
                  setError('');
                } catch (issue) {
                  setError(issue instanceof Error ? issue.message : '目标草稿保存失败');
                }
              }}
            />
          </label>
          <p className="field-help project-item-setup-counter" id={objectiveHelpId}>
            {objective.length} / 20000 字符
          </p>
          {error && (
            <p
              className="field-error project-item-setup-reading"
              role="alert"
              tabIndex={0}
              aria-label="交付项创建草稿保存错误全文"
            >
              {error}
            </p>
          )}
        </section>
      }
      settings={(setup) => {
        if (save(setup)) settings();
      }}
      submit={(body, setup) => {
        const saved = save(setup);
        if (saved) submit(body, saved);
      }}
    />
  );
}
