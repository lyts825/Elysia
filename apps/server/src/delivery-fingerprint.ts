import type { Artifact, Run, Task } from '../../../packages/contracts/src/index.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';

/** Reviews bind to delivery content, never to the review itself or unrelated run metadata. */
export function deliveryFingerprint(store: Store, run: Pick<Run, 'id'>, root: Task) {
  const legacy = new Set(
    (
      store.db
        .prepare(
          "SELECT id FROM artifacts WHERE run_id=? AND json_extract(data,'$.deliverySemanticHash') IS NULL",
        )
        .all(run.id) as { id: string }[]
    ).map((item) => item.id),
  );
  const artifacts = store.all<Artifact>('artifacts', run.id).map((artifact) => {
    if (legacy.has(artifact.id)) store.refreshReadProjection('artifacts', artifact);
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
