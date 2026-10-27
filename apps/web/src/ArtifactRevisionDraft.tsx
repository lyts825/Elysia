/* 校验和管理产物修订选择草稿。 */
import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import {
  artifactChangeTextByteLength,
  type DeliveryArtifactChange,
} from '../../../packages/contracts/src/workflow';
import './artifact-revision-draft.css';

const metadata = z.object({
  id: z.string(),
  taskId: z.string(),
  name: z.string(),
  version: z.number(),
  hash: z.string(),
  mediaType: z.string(),
  verified: z.boolean(),
});
const entryShape = z.object({
  reviewId: z.string(),
  fingerprint: z.string(),
  requirement: z.string(),
  added: z.boolean(),
  change: z.object({
    artifactId: z.string(),
    kind: z.enum(['added', 'removed', 'changed']),
    before: metadata.nullable(),
    after: metadata.nullable(),
    currentArtifactId: z.string().nullable(),
  }),
});
export type ArtifactRevisionEntry = z.infer<typeof entryShape>;
export function readArtifactRevision(raw: unknown): ArtifactRevisionEntry[] | undefined {
  if (raw === undefined) return [];
  const result = z.array(entryShape).max(40).safeParse(raw);
  return result.success ? result.data : undefined;
}
export const artifactRevisionKey = (entry: Pick<ArtifactRevisionEntry, 'reviewId' | 'change'>) =>
  `${entry.reviewId}:${entry.change.artifactId}`;
export function artifactRevisionIssue(entries: ArtifactRevisionEntry[]) {
  const selected = entries.filter((entry) => entry.added);
  if (selected.length > 20) return '最多带入 20 项差异，请减少选择。';
  if (selected.some((entry) => !entry.requirement.trim() || entry.requirement.length > 2000))
    return '请为每项差异填写具体要求（不超过 2000 字）。';
  if (artifactChangeTextByteLength(selected) > 16 * 1024)
    return '修改要求合计超过 16 KiB，请减少选择；原文不会截断。';
  if (
    new TextEncoder().encode(
      JSON.stringify(
        selected.map((entry) => ({
          ...entry.change,
          reviewId: entry.reviewId,
          reviewFingerprint: '0'.repeat(64),
          currentFingerprint: entry.fingerprint,
          requirement: entry.requirement,
        })),
      ),
    ).length >
    32 * 1024
  )
    return '差异及修改要求超过 32 KiB，请减少选择；原文不会截断。';
  return '';
}
type RevisionContext = {
  runId: string;
  entries: ArtifactRevisionEntry[];
  change: (entries: ArtifactRevisionEntry[]) => boolean;
};
const Context = createContext<RevisionContext | null>(null);
export function ArtifactRevisionProvider({
  runId,
  raw,
  change,
  children,
  disabled,
}: {
  runId: string;
  raw: unknown;
  change?: (raw: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  const rawRef = useRef(raw);
  rawRef.current = raw;
  let draft: Record<string, unknown> = {},
    invalid = false;
  if (raw) {
    try {
      const parsed = JSON.parse(String(raw));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid = true;
      else draft = parsed;
    } catch {
      invalid = true;
    }
  }
  const entries = readArtifactRevision(draft.artifactRevision);
  return (
    <Context.Provider
      value={
        change && !disabled && !invalid && entries
          ? {
              runId,
              entries,
              change: (next) => {
                if (next.length > 40) {
                  setError('差异草稿最多保留 40 项，请先移除不再需要的内容。');
                  return false;
                }
                let latest: Record<string, unknown> = {};
                try {
                  if (rawRef.current) latest = JSON.parse(String(rawRef.current));
                } catch {
                  setError('修订草稿无法读取，原稿保留。');
                  return false;
                }
                const text = JSON.stringify({ ...latest, artifactRevision: next });
                if (text.length > 200000) {
                  setError('修订草稿已达本机上限，本次修改未写入。');
                  return false;
                }
                rawRef.current = text;
                change(text);
                setError('');
                return true;
              },
            }
          : null
      }
    >
      {(error || invalid || !entries) && (
        <p
          role="alert"
          className="field-error revision-draft-reading revision-draft-error"
          tabIndex={0}
          aria-label="修订草稿保存或读取问题全文"
        >
          {error || '修订草稿无法读取，已保留原稿；暂不能加入差异。'}
        </p>
      )}
      {children}
    </Context.Provider>
  );
}
export function ArtifactRevisionEditor({
  runId,
  reviewId,
  fingerprint,
  item,
  disabled,
}: {
  runId: string;
  reviewId: string;
  fingerprint: string;
  item: DeliveryArtifactChange;
  disabled: boolean;
}) {
  const context = useContext(Context);
  const helpId = useId();
  if (!context || context.runId !== runId) return null;
  const key = `${reviewId}:${item.artifactId}`,
    entry = context.entries.find((e) => artifactRevisionKey(e) === key);
  const requirement = entry?.requirement || '';
  const candidate = { reviewId, fingerprint, change: item, requirement, added: true };
  const next = context.entries.filter((e) => artifactRevisionKey(e) !== key);
  const issue = artifactRevisionIssue([...next, candidate]);
  return (
    <section className="revision-draft-editor" aria-label="差异修改要求">
      <p className="revision-draft-state" role="status">
        {entry?.added
          ? entry.fingerprint === fingerprint
            ? '已加入修改清单'
            : '此前已加入；版本变化，请核对后重新加入'
          : '当前为待加入草稿，填写后需明确加入。'}
      </p>
      <label>
        此差异的具体修改要求
        <textarea
          aria-label={`修改要求：${item.after?.name ?? item.before?.name ?? item.artifactId}`}
          aria-describedby={helpId}
          rows={2}
          value={requirement}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) =>
            context.change([...next, { ...candidate, requirement: event.target.value, added: false }])
          }
        />
        <small className="revision-draft-count">
          {requirement.length.toLocaleString()} / 2000 字 · 本项{' '}
          {artifactChangeTextByteLength([{ requirement }]).toLocaleString()} 字节
        </small>
      </label>
      <p className="field-help" id={helpId}>
        只加入差异说明，不带入产物正文。输入保留到修订草稿；修改文字后需重新加入。
      </p>
      <details className="revision-draft-source">
        <summary>核对修改目标与来源</summary>
        <dl className="revision-draft-reading" role="region" aria-label="当前差异完整目标与来源" tabIndex={0}>
          <div>
            <dt>修改目标</dt>
            <dd>{item.after?.name ?? item.before?.name ?? item.artifactId}</dd>
          </div>
          <div>
            <dt>来源复核</dt>
            <dd>{reviewId}</dd>
          </div>
          <div>
            <dt>产物标识</dt>
            <dd>{item.artifactId}</dd>
          </div>
          <div>
            <dt>差异类型</dt>
            <dd>{{ added: '新增', removed: '已移除', changed: '已变化' }[item.kind]}</dd>
          </div>
          <div>
            <dt>版本对照</dt>
            <dd>
              {item.before ? `原版本 v${item.before.version}` : '原版本无'} →{' '}
              {item.after ? `本次读取 v${item.after.version}` : '本次已移除'}
            </dd>
          </div>
          <div>
            <dt>当前交付指纹</dt>
            <dd>{fingerprint}</dd>
          </div>
        </dl>
      </details>
      {issue && requirement && <p className="field-help revision-draft-issue">{issue}</p>}
      <button
        type="button"
        className="secondary"
        disabled={disabled || !!issue || (!!entry?.added && entry.fingerprint === fingerprint)}
        onClick={() => context.change([...next, candidate])}
      >
        加入修改清单
      </button>
    </section>
  );
}
