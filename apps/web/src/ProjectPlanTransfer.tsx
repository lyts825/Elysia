import { useEffect, useId, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { PROJECT_BOARD_DRAFT_LIMIT, type ProjectBoardEdit } from './ProjectBoardDraft';
import {
  PROJECT_PLAN_FILE_LIMIT,
  exportProjectPlan,
  readProjectPlanTransfer,
  type ProjectPlanImportPreflight,
  type ProjectPlanTransfer as PlanFile,
} from './project-plan-transfer';
import './project-plan-transfer.css';
export type PlanImportLifecycle = { hasPending: () => boolean; discard: () => void };

export function ProjectPlanTransfer({
  projectId,
  edit,
  busy,
  canRestore,
  apply,
  restore,
  inspect,
  exportOriginal,
  lifecycle,
}: {
  projectId: string;
  edit: ProjectBoardEdit;
  busy: boolean;
  canRestore: boolean;
  apply: (file: PlanFile) => boolean;
  restore: () => boolean;
  inspect: (file: PlanFile) => ProjectPlanImportPreflight;
  exportOriginal: () => void;
  lifecycle: RefObject<PlanImportLifecycle | null>;
}) {
  const identity = useId();
  const [preview, setPreview] = useState<{ file: PlanFile; name: string }>();
  const [reading, setReading] = useState(false),
    [acknowledgedKey, setAcknowledgedKey] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    pending = useRef(false);
  useImperativeHandle(
    lifecycle,
    () => ({
      hasPending: () => pending.current,
      discard: () => {
        generation.current++;
        pending.current = false;
        setReading(false);
        setPreview(undefined);
        setAcknowledgedKey('');
      },
    }),
    [],
  );
  const confirmationKey = JSON.stringify([edit, preview?.file]);
  const capacity = preview ? inspect(preview.file) : undefined;
  const canApply = capacity?.canApply === true;
  useEffect(() => setAcknowledgedKey(''), [confirmationKey]);
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const read = async (file: File) => {
    const request = ++generation.current;
    setPreview(undefined);
    setAcknowledgedKey('');
    setNotice('');
    setError('');
    pending.current = true;
    if (file.size > PROJECT_PLAN_FILE_LIMIT) {
      setError('计划文件超过 192 KiB，原草稿未改动。');
      setReading(false);
      pending.current = false;
      return;
    }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (request !== generation.current) return;
      if (bytes.byteLength > PROJECT_PLAN_FILE_LIMIT) throw Error('计划文件超过 192 KiB，原草稿未改动。');
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw Error('计划文件不是有效 UTF-8，原草稿未改动。');
      }
      const result = readProjectPlanTransfer(raw);
      setPreview({ file: result, name: file.name });
    } catch (issue) {
      if (request === generation.current) {
        pending.current = false;
        setError(issue instanceof Error ? issue.message : '计划文件读取失败，原草稿未改动。');
      }
    } finally {
      if (request === generation.current) setReading(false);
    }
  };
  return (
    <section className="project-plan-transfer" aria-label="项目计划复用">
      <h3>复用项目计划</h3>
      <p className="field-help">
        导出当前编辑草稿，供其他项目调整目标、范围和验收标准。JSON
        仅含计划，不带任务、确认、复核或保存包；导入不会继承历史完成状态。
      </p>
      <div className="project-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setError('');
            setNotice('');
            try {
              const raw = exportProjectPlan(edit);
              const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = `elysia-project-plan-${projectId}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice('已导出当前编辑计划，项目保存状态未改变。');
            } catch (issue) {
              setError(issue instanceof Error ? issue.message : '导出计划失败，草稿已保留。');
            }
          }}
        >
          导出当前编辑草稿 JSON
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || canRestore}
          onClick={() => fileInput.current?.click()}
        >
          导入计划 JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="project-plan-file-input"
          aria-label="选择项目计划 JSON 文件"
          disabled={busy || canRestore}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void read(file);
          }}
        />
        {canRestore && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (restore()) {
                generation.current++;
                pending.current = false;
                setReading(false);
                setPreview(undefined);
                setAcknowledgedKey('');
                setError('');
                setNotice('已恢复导入前原稿，项目保存状态未改变。');
              }
            }}
          >
            恢复导入前原稿 · 替换当前编辑内容
          </button>
        )}
      </div>
      <p className="field-help">接受 version 1、最大 192 KiB、最多 40 个交付项。读取和预览均保留当前草稿。</p>
      <p className="field-help">
        未应用的导入预览仅在当前编辑页临时保留；离开或重开后需重选文件。编辑内容和已应用的导入前原稿仍保留。
      </p>
      {reading && <p role="status">正在读取计划文件…</p>}
      {error && (
        <p
          className="field-error project-plan-reading"
          role="alert"
          aria-label="项目计划复用问题全文"
          tabIndex={0}
        >
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {canRestore && (
        <p className="field-help">
          导入前原稿已随工作台草稿保留；返回或重开后仍可恢复。请先恢复原稿或成功保存项目计划，再导入另一份计划；保存成功后会清除这份备份。
        </p>
      )}
      {preview && (
        <section className="project-plan-preview" aria-label="导入计划预览">
          <div className="project-plan-preview-heading">
            <h4>导入计划预览</h4>
            <span>{preview.file.plan.items.length} 个交付项</span>
          </div>
          <p
            className="project-plan-filename project-plan-reading"
            id={`${identity}-filename`}
            role="region"
            aria-label="本次导入计划完整文件名"
            tabIndex={0}
          >
            {preview.name}
          </p>
          <p className="field-help">
            应用后可在本项目编辑。全部交付项使用新编号；保存后仍需重新关联任务和确认，现有任务与历史交付清单不会迁移到新编号。核对后仍需点击“保存项目计划”。
          </p>
          <section
            className="project-plan-capacity"
            aria-label="导入草稿容量检查"
            data-status={canApply ? 'ready' : 'blocked'}
          >
            {capacity?.canApply ? (
              <>
                <p role="status">
                  保留导入前原稿后，本项目草稿为 {capacity.characters.toLocaleString('zh-CN')} /{' '}
                  {PROJECT_BOARD_DRAFT_LIMIT.toLocaleString('zh-CN')} 字符，可应用。
                </p>
                {capacity.baselineOmitted && (
                  <p className="field-help">
                    原始计划基线因容量限制未保留；输入和导入前原稿完整保留。计划版本变化时仍需逐项核对差异。
                  </p>
                )}
              </>
            ) : (
              <>
                <p
                  className="field-error project-plan-reading"
                  role="alert"
                  aria-label="导入草稿容量问题全文"
                  tabIndex={0}
                >
                  {capacity?.error}
                </p>
                <p className="field-help">
                  尚未替换当前草稿。可先下载完整原稿，再缩小导入计划或当前草稿；不会截断输入或移除导入前原稿。
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    try {
                      exportOriginal();
                      setError('');
                      setNotice('已下载完整工作台原稿，当前草稿与导入预览未改变。');
                    } catch (issue) {
                      setError(
                        issue instanceof Error ? issue.message : '原稿下载失败，当前草稿与导入预览已保留。',
                      );
                    }
                  }}
                >
                  导出完整原稿 TXT
                </button>
              </>
            )}
          </section>
          <div
            className="project-plan-preview-content"
            role="region"
            aria-label="项目计划替换对照内容"
            tabIndex={0}
          >
            <h4>当前草稿 → 导入计划</h4>
            {[
              { label: '项目目标', current: edit.goal, imported: preview.file.plan.goal },
              { label: '范围', current: edit.scope, imported: preview.file.plan.scope.join('\n') },
              { label: '不做事项', current: edit.nonGoals, imported: preview.file.plan.nonGoals.join('\n') },
            ].map(({ label, current, imported }) => (
              <section
                className="project-plan-comparison-section"
                key={label}
                aria-label={`${label}替换对照`}
              >
                <div className="project-plan-comparison-heading">
                  <h4>{label}</h4>
                  <span className="project-plan-diff-state" data-changed={current !== imported}>
                    {current === imported ? '文字一致' : '文字不同'}
                  </span>
                </div>
                <div className="project-plan-comparison-columns">
                  <div>
                    <strong>当前草稿</strong>
                    <p>{current || '（空）'}</p>
                  </div>
                  <div>
                    <strong>导入计划</strong>
                    <p>{imported || '（空）'}</p>
                  </div>
                </div>
              </section>
            ))}
            <section className="project-plan-comparison-section" aria-label="交付项替换对照">
              <h4>交付项全部替换</h4>
              <p>
                当前 {edit.items.length} 项（必需 {edit.items.filter((item) => item.required).length} 项） →
                导入 {preview.file.plan.items.length} 项（必需{' '}
                {preview.file.plan.items.filter((item) => item.required).length} 项）。
              </p>
              <p className="field-help">
                两侧独立列出全部内容，不按名称配对或合并。同名或文字一致的交付项也会生成新编号，原有关联不会迁移。
              </p>
              <div className="project-plan-comparison-columns">
                <div>
                  <h4>当前草稿交付项</h4>
                  {!edit.items.length && <p>（无交付项）</p>}
                  {edit.items.map((item, index) => (
                    <PlanItemText key={item.id} item={item} index={index} side="当前草稿" />
                  ))}
                </div>
                <div>
                  <h4>导入计划交付项</h4>
                  {!preview.file.plan.items.length && <p>（无交付项）</p>}
                  {preview.file.plan.items.map((item, index) => (
                    <PlanItemText key={index} item={item} index={index} side="导入" />
                  ))}
                </div>
              </div>
            </section>
          </div>
          <div className="project-plan-confirmation">
            <p className="project-plan-confirmation-state" id={`${identity}-confirmation`} role="status">
              {busy
                ? '当前操作处理中，暂不可应用导入预览。'
                : canRestore
                  ? '已有导入前原稿，请先恢复原稿或保存项目计划。'
                  : !canApply
                    ? '当前导入检查未通过，尚不能替换编辑内容。'
                    : acknowledgedKey === confirmationKey
                      ? '已确认替换当前编辑内容，尚未应用。'
                      : '请核对完整对照，并明确勾选替换确认。'}
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={acknowledgedKey === confirmationKey}
                disabled={busy || !canApply}
                onChange={(event) => setAcknowledgedKey(event.target.checked ? confirmationKey : '')}
              />
              <span>用此计划替换当前编辑内容；导入前原稿保留，可在保存前恢复。</span>
            </label>
            <div className="project-actions">
              <button
                type="button"
                className="primary"
                aria-describedby={`${identity}-filename ${identity}-confirmation`}
                disabled={busy || canRestore || !canApply || acknowledgedKey !== confirmationKey}
                onClick={() => {
                  if (apply(preview.file)) {
                    pending.current = false;
                    setPreview(undefined);
                    setAcknowledgedKey('');
                    setNotice('已应用到本项目编辑草稿。请调整并核对，再保存项目计划。');
                    setError('');
                  } else {
                    setNotice('应用未完成，导入预览仍保留。请核对工作台提示后重试。');
                  }
                }}
              >
                应用到编辑草稿
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  generation.current++;
                  pending.current = false;
                  setPreview(undefined);
                  setAcknowledgedKey('');
                  setNotice('已取消导入预览，当前草稿未改动。');
                }}
              >
                取消导入 · 保留当前草稿
              </button>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}

function PlanItemText({
  item,
  index,
  side,
}: {
  item: ProjectBoardEdit['items'][number] | PlanFile['plan']['items'][number];
  index: number;
  side: '当前草稿' | '导入';
}) {
  return (
    <section className="project-plan-item" aria-label={`${side}交付项 ${index + 1}`}>
      <h4>
        {index + 1}. {item.title || '（未命名）'} · {item.required ? '必需' : '可选'}
      </h4>
      <p>{item.description || '（无说明）'}</p>
      <strong>交付物</strong>
      <p>
        {(Array.isArray(item.deliverables) ? item.deliverables.join('\n') : item.deliverables) || '（空）'}
      </p>
      <strong>验收标准</strong>
      <p>
        {(Array.isArray(item.acceptanceCriteria)
          ? item.acceptanceCriteria.join('\n')
          : item.acceptanceCriteria) || '（空）'}
      </p>
    </section>
  );
}
