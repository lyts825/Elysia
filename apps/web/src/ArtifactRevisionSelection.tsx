import { useEffect, useRef, useState } from 'react';
import type {
  DeliveryArtifactChange,
  DeliveryArtifactChangePage,
  SourceArtifactChange,
} from '../../../packages/contracts/src/workflow';
import {
  artifactRevisionIssue,
  artifactRevisionKey,
  readArtifactRevision,
  type ArtifactRevisionEntry,
} from './ArtifactRevisionDraft';
import { useSurfaceClient } from './SurfaceClientContext';

export function ArtifactRevisionSummary({
  items,
}: {
  items: (Pick<ArtifactRevisionEntry, 'change' | 'requirement'> | SourceArtifactChange)[];
}) {
  return (
    <section aria-label="修改清单">
      <h4>修改清单 · {items.length} 项差异</h4>
      {items.map((entry, index) => {
        const item = 'change' in entry ? entry.change : entry;
        return (
          <div key={index} className="workflow-selection">
            <strong>
              {{ added: '新增', removed: '已移除', changed: '已变化' }[item.kind]} ·{' '}
              {item.after?.name ?? item.before?.name ?? item.artifactId}
            </strong>
            <p className="field-help">
              原版本 {item.before ? `v${item.before.version} · ${item.before.hash.slice(0, 12)}` : '无'} →
              选定时 {item.after ? `v${item.after.version} · ${item.after.hash.slice(0, 12)}` : '已移除'}
            </p>
            <p className="workflow-prose">修改要求：{entry.requirement}</p>
          </div>
        );
      })}
      <p className="field-help">
        此清单仅包含差异元数据与修改要求；不包含文件正文。需要正文时请单独选择产物。
      </p>
    </section>
  );
}
export function ArtifactRevisionSelection({
  runId,
  raw,
  change,
  fingerprint,
  disabled,
  reload,
}: {
  runId: string;
  raw: unknown;
  change: (entries: ArtifactRevisionEntry[]) => void;
  fingerprint?: string;
  disabled: boolean;
  reload: () => void;
}) {
  const { api } = useSurfaceClient();
  const entries = readArtifactRevision(raw);
  const ref = useRef(entries);
  ref.current = entries;
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<{
    key: string;
    fingerprint: string;
    change: DeliveryArtifactChange | null;
  }>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setCurrent(undefined);
    setBusy(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [runId, fingerprint]);
  async function reread(entry: ArtifactRevisionEntry) {
    if (!fingerprint || busy || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setCurrent(undefined);
    try {
      const query = new URLSearchParams({
        expectedCurrentFingerprint: fingerprint,
        artifactId: entry.change.artifactId,
      });
      const page = await api<DeliveryArtifactChangePage>(
        `/runs/${runId}/delivery/reviews/${entry.reviewId}/artifact-changes?${query}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        page.runId !== runId ||
        page.reviewId !== entry.reviewId ||
        page.currentFingerprint !== fingerprint ||
        !page.page
      )
        throw Error('无法确定这项差异，请重新读取来源后处理，原稿保留。');
      setCurrent({
        key: artifactRevisionKey(entry),
        fingerprint,
        change: page.items.find((item) => item.artifactId === entry.change.artifactId) || null,
      });
    } catch (issue) {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '差异读取失败。');
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  if (!entries)
    return (
      <section className="workflow-source">
        <p role="alert">差异草稿无法读取，原文已保留。请先保留所需内容，再清除此部分选择。</p>
        <button type="button" disabled={disabled} onClick={() => change([])}>
          清除无法读取的差异选择
        </button>
      </section>
    );
  if (!entries.length) return null;
  return (
    <section className="workflow-source" aria-label="调整修改清单">
      <h3>
        差异修改清单 · 已加入 {entries.filter((e) => e.added).length} 项 · 待加入{' '}
        {entries.filter((e) => !e.added).length} 项
      </h3>
      {entries.map((entry) => {
        const key = artifactRevisionKey(entry),
          stale = entry.fingerprint !== fingerprint;
        const patch = (next: Partial<ArtifactRevisionEntry>) =>
          change((ref.current || []).map((e) => (artifactRevisionKey(e) === key ? { ...e, ...next } : e)));
        const issue = artifactRevisionIssue([
          ...entries.filter((e) => artifactRevisionKey(e) !== key),
          { ...entry, added: true },
        ]);
        return (
          <div key={key} className="workflow-selection">
            <ArtifactRevisionSummary items={[entry]} />
            <label>
              具体修改要求
              <textarea
                aria-label={`清单修改要求：${entry.change.after?.name ?? entry.change.before?.name}`}
                value={entry.requirement}
                rows={2}
                maxLength={2000}
                disabled={disabled || busy}
                onChange={(event) => patch({ requirement: event.target.value, added: false })}
              />
            </label>
            {stale && (
              <p className="inline-warning">
                来源交付版本已变化，请读取这项最新差异并明确确认；旧选择仍保留。
              </p>
            )}
            {stale && (
              <button
                type="button"
                className="secondary"
                disabled={disabled || busy || !fingerprint}
                onClick={() => void reread(entry)}
              >
                {busy ? '正在读取…' : '核对这项最新差异'}
              </button>
            )}
            {current?.key === key && current.fingerprint === fingerprint && (
              <section className="workflow-source">
                {current.change ? (
                  <>
                    <ArtifactRevisionSummary
                      items={[{ change: current.change, requirement: entry.requirement }]}
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || busy}
                      onClick={() => {
                        patch({ change: current.change!, fingerprint: current.fingerprint, added: false });
                        setCurrent(undefined);
                      }}
                    >
                      确认最新差异，保留要求待加入
                    </button>
                  </>
                ) : (
                  <p>当前已不存在这项差异。请明确移除旧选择，或保留草稿；不会自动带入。</p>
                )}
              </section>
            )}
            {issue && <p className="field-help">{issue}</p>}
            <div className="workflow-actions">
              <button
                type="button"
                className="secondary"
                disabled={disabled || busy || stale || !!issue || entry.added}
                onClick={() => patch({ added: true })}
              >
                确认加入此修改
              </button>
              <button
                type="button"
                className="text-button"
                disabled={disabled || busy}
                onClick={() => change(entries.filter((e) => artifactRevisionKey(e) !== key))}
              >
                移除此差异选择
              </button>
            </div>
          </div>
        );
      })}
      {error && (
        <p className="field-error" role="alert">
          {error}{' '}
          <button type="button" disabled={disabled || busy} onClick={reload}>
            重新读取来源
          </button>
        </p>
      )}
    </section>
  );
}
