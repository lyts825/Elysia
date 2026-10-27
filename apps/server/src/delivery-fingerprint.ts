/** 根据运行和交付物元数据计算交付指纹。 */
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type { DeliveryArtifactMetadata } from '../../../packages/contracts/src/workflow.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';
import { cachedDeliveryRead } from './delivery-read-cache.js';
import { serializeDeliveryArtifactMetadata } from '../../../packages/storage/src/artifact-delivery-metadata.js';

export function deliveryArtifactRows(store: Store, runId: string) {
  return cachedDeliveryRead(store, `artifacts:${runId}`, () => store.artifactDeliveryMetadata(runId));
}

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
/** Reviews bind to delivery content, never to the review itself or unrelated run metadata. */
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
  // Preserve the v1 canonical bytes while avoiding repeated object-key sorts for all metadata.
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
export function deliveryFingerprint(store: Store, run: Pick<Run, 'id'>, root: Task) {
  return deliveryFingerprintFromArtifacts(run, root, deliveryArtifactMetadata(store, run.id));
}
