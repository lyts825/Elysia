/**
 * 根据运行和交付物元数据计算交付指纹。
 * 综合根任务合同、结果与产物元数据形成身份摘要；无法完整核验则拒绝计算，指纹不评价内容质量。
 * EN: Computes delivery fingerprints from run and artifact metadata. Combines root contract/result and artifact metadata into identity hashes, rejecting incomplete verification without scoring content quality.
 */
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type { DeliveryArtifactMetadata } from '../../../packages/contracts/src/workflow.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';
import { cachedDeliveryRead } from './delivery-read-cache.js';
import { serializeDeliveryArtifactMetadata } from '../../../packages/storage/src/artifact-delivery-metadata.js';

/**
 * 按运行读取交付产物元数据，复用交付读取缓存。
 * EN: Reads delivery-artifact metadata for a run through the delivery-read cache.
 */
export function deliveryArtifactRows(store: Store, runId: string) {
  return cachedDeliveryRead(store, `artifacts:${runId}`, () => store.artifactDeliveryMetadata(runId));
}

/**
 * 从缓存行提取交付语义字段，排除运行归属等不参与产物内容比较的存储字段。
 * EN: Extracts semantic artifact fields from cached rows, excluding storage-only ownership fields from content comparison.
 */
export function deliveryArtifactMetadata(
  store: Store,
  runId: string,
  artifacts = deliveryArtifactRows(store, runId),
): DeliveryArtifactMetadata[] {
  return artifacts.map((artifact) => {
    return {
      id: artifact.id,
      taskId: artifact.taskId,
      name: artifact.name,
      version: artifact.version,
      hash: artifact.hash,
      mediaType: artifact.mediaType,
      verified: artifact.verified,
    };
  });
}
/**
 * 复核绑定交付内容，不把复核自身或无关运行元数据纳入指纹。 基于根任务要求、结果和产物生成交付指纹；产物按 ID 排序以保证稳定。
 * EN: Reviews bind to delivery content, never to the review itself or unrelated run metadata. Fingerprints root-task requirements, results, and artifacts; artifacts are ID-sorted for stability.
 */
export function deliveryFingerprintFromArtifacts(
  run: Pick<Run, 'id'>,
  root: Task,
  artifacts: ReturnType<typeof deliveryArtifactMetadata>,
) {
  const fields = {
    version: 1,
    runId: run.id,
    rootTaskId: root.id,
    status: root.status,
    deliverables: root.spec.deliverables,
    acceptanceCriteria: root.spec.acceptanceCriteria,
    result: root.result ?? null,
    artifacts: artifacts,
  };
  const artifactJson =
    '[' +
    [...artifacts]
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .map(serializeDeliveryArtifactMetadata)
      .join(',') +
    ']';
  /**
   * 保留v1规范字节，同时避免对全部元数据反复排序对象键。
   * EN: Preserve the v1 canonical bytes while avoiding repeated object-key sorts for all metadata.
   */
  return hash(
    '{' +
      Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(
          ([key, value]) => JSON.stringify(key) + ':' + (key === 'artifacts' ? artifactJson : stable(value)),
        )
        .join(',') +
      '}',
  );
}
/**
 * 读取当前产物元数据后计算内容指纹；不读文件字节，也不把人工复核本身纳入指纹。
 * EN: Computes current content fingerprints from artifact metadata without reading file bytes or including the human review itself.
 */
export function deliveryFingerprint(store: Store, run: Pick<Run, 'id'>, root: Task) {
  return deliveryFingerprintFromArtifacts(run, root, deliveryArtifactMetadata(store, run.id));
}
