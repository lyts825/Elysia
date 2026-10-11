import { useEffect, useRef, useState } from 'react';
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

type RowDraft = {
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
  const current =
    value?.runId === delivery.runId &&
    value.currentFingerprint === delivery.fingerprint &&
    value.rootRevision === delivery.rootRevision
      ? value
      : undefined;
  const locked =
    disabled || !change || reading || saving !== undefined || !current?.writable || !!error || !draft;
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
    <section className="workflow-source" aria-label="来源意见逐条复验">
      <h3>来源意见逐条复验</h3>
      <p className="field-help">
        逐条对照当前标准和证据，由你登记处理结果。执行完成或采纳交付不会自动解决原意见。
      </p>
      {reading && <p role="status">正在读取来源意见复验…</p>}
      {!draft && (
        <p className="field-error" role="alert">
          复验草稿格式无法读取，原文已保留；请先保留所需内容。
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}{' '}
          <button
            type="button"
            disabled={reading || saving !== undefined}
            onClick={conflict ? reload : () => setRetry((n) => n + 1)}
          >
            重新读取，保留输入
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {current?.items.map((row) => {
        const key = `${current.sourceHash}:${row.noteIndex}`,
          item = draft?.items[key],
          saved = row.resolution;
        const stale = !!item && item.fingerprint !== current.currentFingerprint,
          concurrent = !!item && item.revision !== (saved?.revision || 0);
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
          <section className="workflow-selection" key={key} aria-label={`原意见 ${row.noteIndex + 1}`}>
            <h4>
              原意见 {row.noteIndex + 1} · {saved?.stale ? '需重新复验' : labels[saved?.status || 'pending']}
            </h4>
            <ReviewSourceNoteBody note={row.sourceNote} compact />
            {saved && (
              <details>
                <summary>已保存处理记录{saved.stale ? '（旧交付版本）' : ''}</summary>
                <p className="workflow-prose">
                  {labels[saved.status]}：{saved.note}
                </p>
                <p>关联标准：{saved.criterionText ?? '整体意见'}</p>
                {saved.evidence.map((e) => (
                  <p key={e.index} className="workflow-prose">
                    {e.type} · {e.note || e.ref}
                  </p>
                ))}
              </details>
            )}
            {!item ? (
              <button type="button" className="secondary" disabled={locked} onClick={begin}>
                编辑本条复验
              </button>
            ) : (
              <>
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
                <label>
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
                <label>
                  处理说明
                  <textarea
                    aria-label={`意见 ${row.noteIndex + 1} 处理说明`}
                    value={item.note}
                    maxLength={1000}
                    rows={2}
                    disabled={locked}
                    onChange={(e) => patch(key, { ...item, note: e.target.value })}
                  />
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
                  <p className="workflow-prose">本次关联：{item.criterionText ?? '整体意见'}</p>
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
                <div className="workflow-actions">
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
              </>
            )}
          </section>
        );
      })}
      {!!draft &&
        Object.entries(draft.items).some(
          ([key]) => !current?.items.some((row) => key === `${current.sourceHash}:${row.noteIndex}`),
        ) && (
          <details>
            <summary>其他来源版本的未保存草稿</summary>
            {Object.entries(draft.items)
              .filter(
                ([key]) => !current?.items.some((row) => key === `${current.sourceHash}:${row.noteIndex}`),
              )
              .map(([key, item]) => (
                <div key={key}>
                  <p className="workflow-prose">{item.note}</p>
                  <p className="field-help">来源已变化或暂不可读，不会按序号套用。</p>
                </div>
              ))}
          </details>
        )}
    </section>
  );
}
