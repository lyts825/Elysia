import type { Artifact, Run, Task } from '../../../packages/contracts/src/index.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';

/** Reviews bind to delivery content, never to the review itself or unrelated run metadata. */
export function deliveryFingerprint(store: Store, run: Pick<Run, 'id'>, root: Task) {
  const artifacts = store.all<Artifact>('artifacts', run.id).map((artifact) => ({
    id: artifact.id,
    taskId: artifact.taskId,
    name: artifact.name,
    version: artifact.version,
    hash: artifact.hash,
    mediaType: artifact.mediaType,
    verified: artifact.verified,
  }));
  return hash(
    stable({
      version: 1,
      runId: run.id,
      rootTaskId: root.id,
      status: root.status,
      deliverables: root.spec.deliverables,
      acceptanceCriteria: root.spec.acceptanceCriteria,
      result: root.result ?? null,
      artifacts: artifacts.sort((a, b) => a.id.localeCompare(b.id, 'en')),
    }),
  );
}
