/**
 * 捕获运行来源中的交付物变更。
 * 为变化比较提供稳定的产物摘要和版本元数据，保留不可读缺口；文件存在不代表内容满足需求。
 * EN: Captures artifact changes from a run's delivery source. Provides stable artifact hashes/revisions for change comparison with explicit unreadable gaps; existence never establishes requirement satisfaction.
 */
import { invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import {
  artifactChangeTextByteLength,
  artifactChangeTextLimitBytes,
  artifactChangeSnapshotLimitBytes,
  type RunSourceSelection,
  type SourceArtifactChange,
} from '../../../packages/contracts/src/workflow.js';
import { stable, type Store } from '../../../packages/storage/src/index.js';
import { deliveryArtifactChanges, savedReviewSnapshot } from './delivery-review-history.js';

/**
 * 只有服务端推导且绑定固定版本的比较元数据才能成为来源指令。 以服务器保存的复核基线重新计算每个选中产物的变化，只接受版本固定且仍可唯一比较的项。 客户端只提供修改要求，不提供可信比较元数据；输出绑定原复核和当前交付双指纹。
 * EN: Only server-derived, version-pinned comparison metadata can become a source instruction. Recomputes selected artifact changes against the stored review baseline, accepting only pinned and uniquely comparable entries. Clients supply change requests, not trusted comparison metadata; output binds both the original review and current delivery fingerprints.
 */
export function captureArtifactChanges(store: Store, run: Run, selection: RunSourceSelection) {
  const selected = selection.artifactChanges ?? [];
  if (!selected.length) return {};
  invariant(
    selected.length <= 20 &&
      new Set(selected.map((item) => `${item.reviewId}:${item.artifactId}`)).size === selected.length,
    'SOURCE_CHANGE_DUPLICATE',
    '最多选择 20 条不重复的产物差异',
  );
  invariant(
    artifactChangeTextByteLength(selected) <= artifactChangeTextLimitBytes,
    'SOURCE_CHANGE_TEXT_LIMIT',
    '差异修改要求合计超过 16 KiB，请减少选择；内容不会自动截断',
  );
  const root = store.require<Task>('tasks', run.rootTaskId);
  invariant(
    run.kind === 'task' &&
      !!run.projectId &&
      run.status === 'DONE' &&
      root.runId === run.id &&
      root.status === 'DONE',
    'SOURCE_CHANGE_SCOPE',
    '产物差异只能来自已交付的原生项目任务',
  );
  invariant(selection.expectedDeliveryFingerprint, 'SOURCE_DELIVERY_REQUIRED', '请核对来源交付版本');
  const artifactChanges: SourceArtifactChange[] = selected.map((item) => {
    const comparison = deliveryArtifactChanges(
      store,
      run,
      item.reviewId,
      selection.expectedDeliveryFingerprint!,
      0,
      item.artifactId,
    );
    invariant(comparison.page, 'SOURCE_CHANGE_UNKNOWN', '原复核基线无法比较，请重新选择可确认的差异');
    invariant(
      comparison.items.length === 1,
      'SOURCE_CHANGE_MISSING',
      '所选产物差异已不存在，请重新读取并选择',
    );
    const review = savedReviewSnapshot(store, run.id, item.reviewId);
    invariant(review, 'SOURCE_CHANGE_REVIEW', '原复核记录不存在');
    return {
      ...comparison.items[0],
      reviewId: item.reviewId,
      reviewFingerprint: review.fingerprint,
      currentFingerprint: comparison.currentFingerprint,
      requirement: item.requirement,
    };
  });
  invariant(
    Buffer.byteLength(stable(artifactChanges), 'utf8') <= artifactChangeSnapshotLimitBytes,
    'SOURCE_CHANGE_SNAPSHOT_LIMIT',
    '所选差异元数据与要求超过 32 KiB，请减少选择；内容不会自动截断',
  );
  return { artifactChanges, capturedDeliveryFingerprint: selection.expectedDeliveryFingerprint };
}
