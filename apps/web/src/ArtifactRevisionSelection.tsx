/**
 * 展示并选择需要修订的产物变更。
 * 将冻结差异与当前指纹绑定，管理加入、移除和逐项修改要求；过期来源保留供核对，不能冒充当前版本。
 * EN: Displays and selects artifact changes that need revision. Binds frozen differences to the current fingerprint and manages selection and per-item requirements; stale sources remain inspectable without being presented as current.
 */
import { useEffect, useId, useRef, useState } from 'react';
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
import './handoff-selection.css';
import './artifact-revision-selection.css';

/**
 * 显示某一侧冻结产物的名称、版本、哈希与核验状态；空版本明确显示缺失，不从其他版本推断。
 * EN: Displays a frozen artifact side including name, version, hash, and verification state. A missing side stays absent rather than being inferred from another revision.
 */
function RevisionMetadata({ label, value }: { label: string; value: DeliveryArtifactChange['before'] }) {
  /**
   * 展示修改前后的完整元数据；缺失版本保持空值，不推断文件内容。
   * EN: Show complete before-and-after metadata. Keep a missing version empty instead of inferring file content.
   */
  return (
    <section className="revision-selection-metadata">
      <h5>{label}</h5>
      {value ? (
        <dl>
          <div>
            <dt>完整名称</dt>
            <dd>{value.name}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>v{value.version}</dd>
          </div>
          <div>
            <dt>完整哈希</dt>
            <dd>{value.hash}</dd>
          </div>
          <div>
            <dt>格式</dt>
            <dd>{value.mediaType}</dd>
          </div>
          <div>
            <dt>核验状态</dt>
            <dd>{value.verified ? '已核验' : '未核验'}</dd>
          </div>
          <div>
            <dt>产物标识</dt>
            <dd>{value.id}</dd>
          </div>
          <div>
            <dt>所属任务</dt>
            <dd>{value.taskId}</dd>
          </div>
        </dl>
      ) : (
        <p>无此版本元数据</p>
      )}
    </section>
  );
}

/**
 * 只展示差异元数据和要求，可嵌入其他面板；不将 removed 项解释成仍可读取的旧文件。
 * EN: Display difference metadata and requirements, optionally embedded in another panel. A removed entry does not imply that its old file remains readable.
 */
export function ArtifactRevisionSummary({
  items,
  embedded = false,
  showRequirement = true,
  afterLabel = '对照版本',
}: {
  items: (Pick<ArtifactRevisionEntry, 'change' | 'requirement'> | SourceArtifactChange)[];
  embedded?: boolean;
  showRequirement?: boolean;
  afterLabel?: string;
}) {
  return (
    <section className="handoff-artifact-summary" aria-label="修改清单">
      {!embedded && <h4>修改清单 · {items.length} 项差异</h4>}
      {items.map((entry, index) => {
        const item = 'change' in entry ? entry.change : entry;
        return (
          <div key={index} className={embedded ? 'workflow-artifact-summary-item' : 'workflow-selection'}>
            <span className="handoff-state">
              {{ added: '新增', removed: '已移除', changed: '已变化' }[item.kind]}
            </span>
            <div
              className="handoff-reading"
              role="region"
              aria-label={`差异 ${index + 1} 产物完整名称`}
              tabIndex={0}
            >
              <strong>{item.after?.name ?? item.before?.name ?? item.artifactId}</strong>
            </div>
            <dl className="handoff-version-pair">
              <div>
                <dt>原版本</dt>
                <dd>{item.before ? `v${item.before.version} · ${item.before.hash.slice(0, 12)}` : '无'}</dd>
              </div>
              <div>
                <dt>{afterLabel}</dt>
                <dd>{item.after ? `v${item.after.version} · ${item.after.hash.slice(0, 12)}` : '已移除'}</dd>
              </div>
            </dl>
            <details className="revision-selection-source">
              <summary>完整版本与核对信息</summary>
              <div
                className="revision-selection-reading"
                role="region"
                tabIndex={0}
                aria-label={`差异 ${index + 1} 完整版本元数据`}
              >
                <RevisionMetadata label="原版本" value={item.before} />
                <RevisionMetadata label={afterLabel} value={item.after} />
                <dl className="revision-selection-reference">
                  <div>
                    <dt>差异产物标识</dt>
                    <dd>{item.artifactId}</dd>
                  </div>
                  <div>
                    <dt>当前产物引用</dt>
                    <dd>{item.currentArtifactId || '无当前产物引用'}</dd>
                  </div>
                </dl>
              </div>
            </details>
            {showRequirement && (
              <div
                className="handoff-reading"
                role="region"
                aria-label={`差异 ${index + 1} 修改要求全文`}
                tabIndex={0}
              >
                <p className="workflow-prose">修改要求：{entry.requirement}</p>
              </div>
            )}
          </div>
        );
      })}
      {!embedded && (
        <p className="field-help">
          此清单仅包含差异元数据与修改要求；不包含文件正文。需要正文时请单独选择产物。
        </p>
      )}
    </section>
  );
}
/**
 * 管理续接草稿中的差异清单；每项保留选取时的交付指纹。
 * 当前指纹变化后可单项重读最新比较结果，已输入的修改要求仍由草稿保存。
 * EN: Manage differences inside a continuation draft, retaining the delivery fingerprint captured when each was selected. After it changes, reread each current comparison separately while keeping the typed requirement.
 */
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
  const identity = useId();
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
  /**
   * 运行或交付指纹变化时废弃当前差异页，并在切换或卸载时取消旧读取，避免旧版本选择污染新列表。
   * EN: Drops the current difference page on run/fingerprint changes and aborts old reads on change or teardown so an old selection cannot contaminate the new list.
   */
  useEffect(() => {
    setCurrent(undefined);
    setBusy(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [runId, fingerprint]);
  /**
   * 按旧复核和产物 ID 查询当前差异，响应必须匹配当前运行、复核和指纹才能供用户重新确认。
   * EN: Query the current difference by the prior review and artifact ID. Accept a response for renewed confirmation only if its run, review, and fingerprint match the current context.
   */
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
      <section className="workflow-source handoff-artifacts revision-selection-editor">
        <p role="alert">差异草稿无法读取，原文已保留。请先保留所需内容，再清除此部分选择。</p>
        <button type="button" className="secondary" disabled={disabled} onClick={() => change([])}>
          清除无法读取的差异选择
        </button>
      </section>
    );
  if (!entries.length) return null;
  return (
    <section
      className="workflow-source handoff-artifacts revision-selection-editor"
      aria-label="调整修改清单"
    >
      <h3>差异修改清单</h3>
      <dl className="revision-selection-counts" aria-label="差异修改清单数量">
        <div>
          <dt>草稿条目</dt>
          <dd>{entries.length} / 40</dd>
        </div>
        <div>
          <dt>已加入</dt>
          <dd>{entries.filter((e) => e.added).length} / 20</dd>
        </div>
        <div>
          <dt>待加入</dt>
          <dd>{entries.filter((e) => !e.added).length}</dd>
        </div>
      </dl>
      <p className="field-help">清单包含差异元数据与修改要求；需要文件正文时请单独选择产物。</p>
      {entries.map((entry, index) => {
        const key = artifactRevisionKey(entry),
          stale = entry.fingerprint !== fingerprint;
        /**
         * 将局部字段合并到当前身份对应的条目；读取最新列表引用，避免闭包中的旧列表覆盖其他编辑。
         * EN: Merges partial fields into the entry with this identity, using the latest list ref so a stale render cannot overwrite other edits.
         */
                const patch = (next: Partial<ArtifactRevisionEntry>) =>
          change((ref.current || []).map((e) => (artifactRevisionKey(e) === key ? { ...e, ...next } : e)));
        const issue = artifactRevisionIssue([
          ...entries.filter((e) => artifactRevisionKey(e) !== key),
          { ...entry, added: true },
        ]);
        return (
          <article key={key} className="workflow-selection" aria-label={`第 ${index + 1} 项差异修改`}>
            <p className="handoff-state">
              第 {index + 1} 项 · {entry.added ? '已加入' : '待加入'}
            </p>
            <details className="revision-selection-source">
              <summary>来源复核与交付版本</summary>
              <dl
                className="revision-selection-reading revision-selection-reference"
                role="region"
                tabIndex={0}
                aria-label={`第 ${index + 1} 项差异复核来源`}
              >
                <div>
                  <dt>来源复核</dt>
                  <dd>{entry.reviewId}</dd>
                </div>
                <div>
                  <dt>选择时指纹</dt>
                  <dd>{entry.fingerprint}</dd>
                </div>
                <div>
                  <dt>当前交付指纹</dt>
                  <dd>{fingerprint || '尚未读取'}</dd>
                </div>
              </dl>
            </details>
            <ArtifactRevisionSummary items={[entry]} embedded showRequirement={false} />
            <label className="workflow-field">
              具体修改要求
              <textarea
                aria-label={`具体修改要求 · 第 ${index + 1} 项`}
                value={entry.requirement}
                rows={2}
                maxLength={2000}
                disabled={disabled || busy}
                aria-describedby={`${identity}-requirement-${index}`}
                onChange={(event) => patch({ requirement: event.target.value, added: false })}
              />
              <span className="field-help handoff-character-count" id={`${identity}-requirement-${index}`}>
                {entry.requirement.length} / 2000 字 · 修改后需重新加入。
              </span>
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
              <section className="workflow-source handoff-current-comparison" aria-label="本次读取的最新差异">
                <h4>本次读取的最新差异</h4>
                {current.change ? (
                  <>
                    <ArtifactRevisionSummary
                      items={[{ change: current.change, requirement: entry.requirement }]}
                      embedded
                      showRequirement={false}
                      afterLabel="本次读取版本"
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
          </article>
        );
      })}
      {error && (
        <div className="field-error workflow-read-error handoff-read-error" role="alert">
          <p className="handoff-reading" role="region" aria-label="差异读取错误全文" tabIndex={0}>
            {error}
          </p>
          <button type="button" className="secondary" disabled={disabled || busy} onClick={reload}>
            重新读取来源
          </button>
        </div>
      )}
    </section>
  );
}
