/* 处理来源备注及其解决状态。 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  DeliveryCriterion,
  DeliveryReview,
  SourceNoteResolutionStatus,
  SourceNoteResolutions as View,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ReviewSourceNoteBody } from './ReviewSourceNotes';
import { CurrentCriterionPicker } from './CurrentCriterionPicker';
import { ResolutionEvidencePicker, type ChosenEvidence } from './ResolutionEvidencePicker';
import { ApiError } from './api';
import { z } from 'zod';
import './source-note-resolutions.css';

type RowDraft = {
  // 保留来源哈希、交付指纹及版本，以便检测旧备注与当前记录是否仍匹配。
  sourceHash: string;
  fingerprint: string;
  revision: number;
  status: SourceNoteResolutionStatus;
  note: string;
  criterionIndex: number | null;
  criterionText: string | null;
  selected: boolean;
  evidence: ChosenEvidence[];
};
type Draft = { version: 1; items: Record<string, RowDraft> };
const artifactShape = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  hash: z.string(),
  mediaType: z.string(),
  verified: z.boolean(),
});
const rowShape = z.object({
  sourceHash: z.string(),
  fingerprint: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['pending', 'resolved', 'needs_changes']),
  note: z.string(),
  criterionIndex: z.number().int().nonnegative().nullable(),
  criterionText: z.string().nullable(),
  selected: z.boolean(),
  evidence: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      type: z.enum(['file', 'artifact', 'command']),
      ref: z.string(),
      hash: z.string().nullable(),
      note: z.string(),
      artifact: artifactShape.nullable(),
    }),
  ),
});
/** 解析有界本机草稿；缺省为空，损坏则禁用写入以保护原始输入，不自动重置。 */
function readDraft(raw: unknown): Draft | undefined {
  if (!raw) return { version: 1, items: {} };
  if (typeof raw !== 'string' || raw.length > 200000) return;
  try {
    const parsed = z
      .object({ version: z.literal(1), items: z.record(z.string(), rowShape) })
      .safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
const labels: Record<SourceNoteResolutionStatus, string> = {
  pending: '待复验',
  resolved: '已解决',
  needs_changes: '仍需修改',
};
/**
 * 逐条登记来源反馈的人工复验结论。草稿按来源哈希和备注索引隔离，并绑定当前交付指纹、
 * 单条处理修订、手选标准与证据；新交付或并发保存后必须明确重新核对才能提交。
 */
export function SourceNoteResolutions({
  delivery,
  raw,
  change,
  disabled,
  reload,
  updated,
  activity,
}: {
  delivery: DeliveryReview;
  raw: unknown;
  change?: (raw: string) => void;
  disabled: boolean;
  reload: () => void;
  updated: (revision: number) => void;
  activity: (busy: boolean) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const id = useId();
  const [value, setValue] = useState<View>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reading, setReading] = useState(true),
    [retry, setRetry] = useState(0),
    [saving, setSaving] = useState<number>();
  const [conflict, setConflict] = useState(false);
  const draft = readDraft(raw),
    ref = useRef(draft);
  ref.current = draft;
  const latestDelivery = useRef(delivery);
  latestDelivery.current = delivery;
  const savePending = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setError('');
    setConflict(false);
    void api<View>(`/runs/${delivery.runId}/source-note-resolutions`, undefined, undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        if (
          next.runId !== delivery.runId ||
          next.currentFingerprint !== delivery.fingerprint ||
          next.rootRevision !== delivery.rootRevision
        )
          throw new ApiError(
            '当前交付已变化，请重新读取交付；复验草稿仍保留。',
            'http',
            409,
            'DELIVERY_CHANGED',
          );
        setValue(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) {
          setError(issue instanceof Error ? issue.message : '来源复验读取失败。');
          setConflict(issue instanceof ApiError && issue.status === 409);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [api, delivery.runId, delivery.fingerprint, delivery.rootRevision, delivery.runRevision, retry]);
  // 屏幕上只采用仍匹配当前交付的服务端处理视图，旧 value 保留也不能开放保存。
  const current =
    value?.runId === delivery.runId &&
    value.currentFingerprint === delivery.fingerprint &&
    value.rootRevision === delivery.rootRevision
      ? value
      : undefined;
  const locked =
    disabled || !change || reading || saving !== undefined || !current?.writable || !!error || !draft;
  /** 局部编辑只写上层本机草稿，超容量拒绝本次修改，完整旧草稿继续保留。 */
  function write(items: Draft['items']) {
    const text = JSON.stringify({ version: 1, items });
    if (text.length > 200000) {
      setError('复验草稿达到本机上限，本次修改未写入；原输入保留。');
      return false;
    }
    ref.current = { version: 1, items };
    change?.(text);
    setNotice('');
    return true;
  }
  function patch(key: string, next: RowDraft) {
    if (ref.current) write({ ...ref.current.items, [key]: next });
  }
  /**
   * 保存单条明确选择的复验，提交四层版本依据：运行、根任务、交付指纹及备注处理修订。
   * 响应回来若交付已更新，仅提示核对实际保存结果，不用旧响应清除当前输入。
   */
  async function save(index: number, key: string, item: RowDraft) {
    if (
      locked ||
      savePending.current ||
      !current ||
      !item.selected ||
      item.fingerprint !== current.currentFingerprint ||
      item.revision !== (current.items.find((i) => i.noteIndex === index)?.resolution?.revision || 0) ||
      (item.status !== 'pending' && !item.note.trim())
    )
      return;
    const token = JSON.stringify(item);
    savePending.current = true;
    setSaving(index);
    activity(true);
    setError('');
    try {
      const next = await mutation<View>(
        `/runs/${delivery.runId}/source-note-resolutions`,
        {
          expectedRevision: current.runRevision,
          expectedRootRevision: current.rootRevision,
          expectedFingerprint: current.currentFingerprint,
          sourceHash: current.sourceHash,
          noteIndex: index,
          expectedResolutionRevision: item.revision,
          status: item.status,
          note: item.note,
          criterionIndex: item.criterionIndex,
          evidenceIndices: item.evidence.map((e) => e.index),
        },
        'PUT',
      );
      if (!live.current) return;
      if (
        next.currentFingerprint !== latestDelivery.current.fingerprint ||
        next.rootRevision !== latestDelivery.current.rootRevision ||
        next.runId !== latestDelivery.current.runId ||
        next.runRevision < latestDelivery.current.runRevision
      ) {
        setConflict(true);
        setError('保存返回时交付已变化，输入仍保留。请重新读取后确认本次记录是否已保存。');
        return;
      }
      if (next.runId !== delivery.runId || next.sourceHash !== current.sourceHash)
        throw Error('返回的来源版本不一致，草稿仍保留。');
      setValue(next);
      updated(next.runRevision);
      // 只清掉与发起时完全相同的草稿，保存期间的新编辑不能因旧请求成功而丢失。
      if (ref.current && JSON.stringify(ref.current.items[key]) === token) {
        const items = { ...ref.current.items };
        delete items[key];
        write(items);
      }
      setNotice('本条复验已保存；原来源备注、执行状态和复核结论均未改变。');
    } catch (issue) {
      if (live.current) {
        setError(issue instanceof Error ? issue.message : '保存失败，草稿保留。');
        setConflict(issue instanceof ApiError && issue.status === 409);
      }
    } finally {
      savePending.current = false;
      if (live.current) {
        setSaving(undefined);
        activity(false);
      }
    }
  }
  if (!reading && !error && !current?.items.length && !Object.keys(draft?.items || {}).length) return null;
  return (
    <section className="workflow-source source-note-resolutions" aria-label="来源意见逐条复验">
      <h3>来源意见逐条复验</h3>
      <p className="field-help">
        逐条对照当前标准和证据，由你登记处理结果。执行完成或采纳交付不会自动解决原意见。
      </p>
      {reading && <p role="status">正在读取来源意见复验…</p>}
      {!reading && current && !current.writable && (
        <p className="source-resolution-notice">当前来源意见仅供阅读，暂不能保存复验。</p>
      )}
      {!draft && (
        <p className="field-error" role="alert">
          复验草稿格式无法读取，原文已保留；请先保留所需内容。
        </p>
      )}
      {error && (
        <div className="field-error workflow-read-error" role="alert">
          <p className="source-resolution-reading" role="region" aria-label="来源复验问题全文" tabIndex={0}>
            {error}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={reading || saving !== undefined}
            onClick={conflict ? reload : () => setRetry((n) => n + 1)}
          >
            重新读取，保留输入
          </button>
        </div>
      )}
      {notice && (
        <p className="source-resolution-notice" role="status">
          {notice}
        </p>
      )}
      {current?.items.map((row) => {
        const key = `${current.sourceHash}:${row.noteIndex}`,
          item = draft?.items[key],
          saved = row.resolution;
        const stale = !!item && item.fingerprint !== current.currentFingerprint,
          concurrent = !!item && item.revision !== (saved?.revision || 0);
        // 旧交付的已保存结论只恢复文字和状态，标准/证据必须重新手选，不能沿用失效关联。
        const begin = () =>
          patch(key, {
            sourceHash: current.sourceHash!,
            fingerprint: current.currentFingerprint,
            revision: saved?.revision || 0,
            status: saved?.status || 'pending',
            note: saved?.note || '',
            criterionIndex: saved && !saved.stale ? saved.criterionIndex : null,
            criterionText: saved && !saved.stale ? saved.criterionText : null,
            selected: !!saved && !saved.stale,
            evidence: saved && !saved.stale ? saved.evidence : [],
          });
        return (
          <section
            className="workflow-selection source-resolution-card"
            key={key}
            aria-label={`原意见 ${row.noteIndex + 1}`}
          >
            <div className="source-resolution-heading">
              <h4>原意见 {row.noteIndex + 1}</h4>
              <span
                className="source-resolution-state"
                data-state={saved?.stale ? 'stale' : saved?.status || 'pending'}
              >
                {saved?.stale ? '需重新复验' : labels[saved?.status || 'pending']}
              </span>
            </div>
            <div
              className="source-resolution-reading source-resolution-original"
              role="region"
              aria-label={`原意见 ${row.noteIndex + 1} 完整内容`}
              tabIndex={0}
            >
              <ReviewSourceNoteBody note={row.sourceNote} compact />
            </div>
            {saved && (
              <details className="source-resolution-saved">
                <summary>已保存处理记录{saved.stale ? '（旧交付版本）' : ''}</summary>
                <p className="field-help">
                  {labels[saved.status]} · 记录版本 {saved.revision}
                </p>
                <h5>处理说明</h5>
                <p
                  className="workflow-prose source-resolution-reading"
                  role="region"
                  aria-label={`意见 ${row.noteIndex + 1} 已保存处理说明`}
                  tabIndex={0}
                >
                  {saved.note || '未附处理说明'}
                </p>
                <h5>已保存关联标准</h5>
                <p
                  className="workflow-prose source-resolution-reading"
                  role="region"
                  aria-label={`意见 ${row.noteIndex + 1} 已保存关联标准`}
                  tabIndex={0}
                >
                  {saved.criterionText ?? '整体意见'}
                </p>
                <h5>已保存证据 · {saved.evidence.length} 条</h5>
                {!saved.evidence.length && <p className="field-help">本条未登记证据引用。</p>}
                {saved.evidence.map((e) => (
                  <section
                    className="source-resolution-saved-evidence"
                    key={e.index}
                    aria-label={`意见 ${row.noteIndex + 1} 已保存证据 ${e.index + 1}`}
                  >
                    <h6>
                      证据 {e.index + 1} · {{ file: '文件', artifact: '产物', command: '命令' }[e.type]}
                    </h6>
                    <dl
                      className="source-resolution-reading"
                      role="region"
                      aria-label={`意见 ${row.noteIndex + 1} 已保存证据 ${e.index + 1} 全文`}
                      tabIndex={0}
                    >
                      <div>
                        <dt>说明</dt>
                        <dd>{e.note || '未附说明'}</dd>
                      </div>
                      <div>
                        <dt>引用</dt>
                        <dd>{e.ref}</dd>
                      </div>
                      {e.hash && (
                        <div>
                          <dt>SHA256</dt>
                          <dd>{e.hash}</dd>
                        </div>
                      )}
                      {e.artifact && (
                        <>
                          <div>
                            <dt>产物名称</dt>
                            <dd>{e.artifact.name}</dd>
                          </div>
                          <div>
                            <dt>版本与格式</dt>
                            <dd>
                              v{e.artifact.version} · {e.artifact.mediaType}
                            </dd>
                          </div>
                          <div>
                            <dt>产物标识</dt>
                            <dd>{e.artifact.id}</dd>
                          </div>
                          <div>
                            <dt>产物 SHA256</dt>
                            <dd>{e.artifact.hash}</dd>
                          </div>
                          <div>
                            <dt>产物核验</dt>
                            <dd>{e.artifact.verified ? '已核验' : '未核验'}</dd>
                          </div>
                        </>
                      )}
                    </dl>
                  </section>
                ))}
              </details>
            )}
            {!item ? (
              <button type="button" className="secondary" disabled={locked} onClick={begin}>
                编辑本条复验
              </button>
            ) : (
              <div
                className="source-resolution-editor"
                role="group"
                aria-label={`意见 ${row.noteIndex + 1} 当前复验草稿`}
              >
                <h5>当前复验草稿</h5>
                <p className="field-help">手选当前关联标准后保存；已解决或仍需修改时须填写处理说明。</p>
                {(stale || concurrent) && (
                  <div className="inline-warning">
                    <p>
                      {stale
                        ? '交付已变化，旧关联不直接用于新版本。请重新手选标准和证据。'
                        : '本条已由其他窗口保存，请核对已保存记录后再继续。'}
                      输入保留。
                    </p>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        patch(key, {
                          ...item,
                          fingerprint: current.currentFingerprint,
                          revision: saved?.revision || 0,
                          ...(stale
                            ? { criterionIndex: null, criterionText: null, evidence: [], selected: false }
                            : {}),
                        })
                      }
                    >
                      {stale ? '对照新版本重新核验' : '以最新记录为基础继续编辑'}
                    </button>
                  </div>
                )}
                <label className="workflow-field">
                  处理状态
                  <select
                    aria-label={`意见 ${row.noteIndex + 1} 处理状态`}
                    value={item.status}
                    disabled={locked}
                    onChange={(e) =>
                      patch(key, { ...item, status: e.target.value as SourceNoteResolutionStatus })
                    }
                  >
                    {Object.entries(labels).map(([status, label]) => (
                      <option key={status} value={status}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="workflow-field">
                  处理说明
                  <textarea
                    aria-label={`意见 ${row.noteIndex + 1} 处理说明`}
                    aria-describedby={`${id}-note-${row.noteIndex}`}
                    value={item.note}
                    maxLength={1000}
                    rows={2}
                    disabled={locked}
                    onChange={(e) => patch(key, { ...item, note: e.target.value })}
                  />
                  <span
                    className="field-help source-resolution-field-help"
                    id={`${id}-note-${row.noteIndex}`}
                  >
                    {item.note.length} / 1000 字 · 待复验时可暂不填写。
                  </span>
                </label>
                {!stale && (
                  <CurrentCriterionPicker
                    key={`criterion:${current.currentFingerprint}:${row.noteIndex}`}
                    initial={delivery}
                    selected={item.selected ? item.criterionIndex : undefined}
                    disabled={locked || concurrent}
                    overall
                    select={(criterion: DeliveryCriterion | null) =>
                      patch(key, {
                        ...item,
                        criterionIndex: criterion?.index ?? null,
                        criterionText: criterion?.text ?? null,
                        selected: true,
                        evidence: [],
                      })
                    }
                  />
                )}
                {item.selected && (
                  <div className="source-resolution-association">
                    <h5>本次关联</h5>
                    <p
                      className="workflow-prose source-resolution-reading"
                      role="region"
                      aria-label={`意见 ${row.noteIndex + 1} 本次关联标准全文`}
                      tabIndex={0}
                    >
                      {item.criterionText ?? '整体意见'}
                    </p>
                    <p className="field-help">本次手选证据 {item.evidence.length} 条</p>
                  </div>
                )}
                {!stale && item.criterionIndex !== null && (
                  <ResolutionEvidencePicker
                    key={`evidence:${current.currentFingerprint}:${item.criterionIndex}`}
                    delivery={delivery}
                    criterion={item.criterionIndex}
                    selected={item.evidence}
                    disabled={locked || concurrent}
                    change={(evidence) => patch(key, { ...item, evidence })}
                  />
                )}
                <div className="workflow-actions source-resolution-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      locked ||
                      stale ||
                      concurrent ||
                      !item.selected ||
                      (item.status !== 'pending' && !item.note.trim())
                    }
                    onClick={() => void save(row.noteIndex, key, item)}
                  >
                    {saving === row.noteIndex ? '正在保存…' : '保存本条复验'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={locked}
                    onClick={() => {
                      const items = { ...ref.current!.items };
                      delete items[key];
                      write(items);
                    }}
                  >
                    放弃本条未保存修改
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      {!!draft &&
        Object.entries(draft.items).some(
          ([key]) => !current?.items.some((row) => key === `${current.sourceHash}:${row.noteIndex}`),
        ) && (
          <details className="source-resolution-other">
            <summary>其他来源版本的未保存草稿</summary>
            {Object.entries(draft.items)
              .filter(
                ([key]) => !current?.items.some((row) => key === `${current.sourceHash}:${row.noteIndex}`),
              )
              .map(([key, item], index) => (
                <div className="source-resolution-saved-evidence" key={key}>
                  <h4>
                    保留草稿 {index + 1} · {labels[item.status]}
                  </h4>
                  <p
                    className="workflow-prose source-resolution-reading"
                    role="region"
                    aria-label={`其他来源保留草稿 ${index + 1} 全文`}
                    tabIndex={0}
                  >
                    {item.note || '未填写处理说明'}
                  </p>
                  <p className="field-help">来源已变化或暂不可读，不会按序号套用。</p>
                </div>
              ))}
          </details>
        )}
    </section>
  );
}
