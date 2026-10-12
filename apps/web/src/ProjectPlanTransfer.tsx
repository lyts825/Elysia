import { useEffect, useRef, useState } from 'react';
import type { ProjectBoardEdit } from './ProjectBoardDraft';
import {
  PROJECT_PLAN_FILE_LIMIT,
  exportProjectPlan,
  readProjectPlanTransfer,
  type ProjectPlanTransfer as PlanFile,
} from './project-plan-transfer';
import './project-plan-transfer.css';

export function ProjectPlanTransfer({
  projectId,
  edit,
  busy,
  canRestore,
  apply,
  restore,
}: {
  projectId: string;
  edit: ProjectBoardEdit;
  busy: boolean;
  canRestore: boolean;
  apply: (file: PlanFile) => boolean;
  restore: () => boolean;
}) {
  const [preview, setPreview] = useState<{ file: PlanFile; name: string }>();
  const [reading, setReading] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const read = async (file: File) => {
    const request = ++generation.current;
    setPreview(undefined);
    setAcknowledged(false);
    setNotice('');
    setError('');
    if (file.size > PROJECT_PLAN_FILE_LIMIT) {
      setError('计划文件超过 192 KiB，原草稿未改动。');
      setReading(false);
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
      if (request === generation.current)
        setError(issue instanceof Error ? issue.message : '计划文件读取失败，原草稿未改动。');
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
                setReading(false);
                setPreview(undefined);
                setAcknowledged(false);
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
      {reading && <p role="status">正在读取计划文件…</p>}
      {error && (
        <p className="field-error" role="alert">
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
          <h4>导入计划预览</h4>
          <p>
            {preview.name} · {preview.file.plan.items.length} 个交付项
          </p>
          <p className="field-help">
            应用后可在本项目编辑。全部交付项使用新编号；保存后仍需重新关联任务和确认，现有任务与历史交付清单不会迁移到新编号。核对后仍需点击“保存项目计划”。
          </p>
          <div className="project-plan-preview-content">
            <h4>项目目标</h4>
            <p>{preview.file.plan.goal || '（空）'}</p>
            <h4>范围</h4>
            <p>{preview.file.plan.scope.join('\n') || '（空）'}</p>
            <h4>不做事项</h4>
            <p>{preview.file.plan.nonGoals.join('\n') || '（空）'}</p>
            {preview.file.plan.items.map((item, index) => (
              <section key={index} aria-label={`导入交付项 ${index + 1}`}>
                <h4>
                  {index + 1}. {item.title} · {item.required ? '必需' : '可选'}
                </h4>
                <p>{item.description || '（无说明）'}</p>
                <strong>交付物</strong>
                <p>{item.deliverables.join('\n')}</p>
                <strong>验收标准</strong>
                <p>{item.acceptanceCriteria.join('\n')}</p>
              </section>
            ))}
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>用此计划替换当前编辑内容；导入前原稿保留，可在保存前恢复。</span>
          </label>
          <div className="project-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || canRestore || !acknowledged}
              onClick={() => {
                if (apply(preview.file)) {
                  setPreview(undefined);
                  setAcknowledged(false);
                  setNotice('已应用到本项目编辑草稿。请调整并核对，再保存项目计划。');
                  setError('');
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
                setPreview(undefined);
                setAcknowledged(false);
                setNotice('已取消导入预览，当前草稿未改动。');
              }}
            >
              取消导入 · 保留当前草稿
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
