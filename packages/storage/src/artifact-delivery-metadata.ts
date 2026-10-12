import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Artifact } from '../../contracts/src/index.js';
import type { DeliveryArtifactMetadata } from '../../contracts/src/workflow.js';
import { hash } from './index.js';

export type DeliveryArtifactRead = DeliveryArtifactMetadata & { runId: string };

export function artifactDeliveryMetadata(artifact: DeliveryArtifactMetadata): DeliveryArtifactMetadata {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    name: artifact.name,
    version: artifact.version,
    hash: artifact.hash,
    mediaType: artifact.mediaType,
    verified: artifact.verified,
  };
}

/** Same canonical key order as stable(), without sorting seven fixed fields per artifact. */
export function serializeDeliveryArtifactMetadata(artifact: DeliveryArtifactMetadata) {
  return JSON.stringify({
    hash: artifact.hash,
    id: artifact.id,
    mediaType: artifact.mediaType,
    name: artifact.name,
    taskId: artifact.taskId,
    verified: artifact.verified,
    version: artifact.version,
  });
}

export function equalDeliveryArtifactMetadata(a: DeliveryArtifactMetadata, b: DeliveryArtifactMetadata) {
  return (
    a.id === b.id &&
    a.taskId === b.taskId &&
    a.name === b.name &&
    a.version === b.version &&
    a.hash === b.hash &&
    a.mediaType === b.mediaType &&
    a.verified === b.verified
  );
}

function valid(value: DeliveryArtifactMetadata, id: string) {
  return (
    value?.id === id &&
    typeof value.taskId === 'string' &&
    value.taskId.length > 0 &&
    typeof value.name === 'string' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 0 &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    typeof value.mediaType === 'string' &&
    typeof value.verified === 'boolean'
  );
}

/** Rebuildable metadata, bound to the original row by transaction-local invalidation.
 * Even an older writer or another SQLite connection clears it on raw body/data repair. */
export class ArtifactDeliveryMetadataReads {
  private save: StatementSync;
  constructor(
    private db: DatabaseSync,
    private readBody: (id: string) => Artifact,
    private refresh: (artifact: Artifact) => void,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_delivery_metadata_v1(
        id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,semantic_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
      );
      CREATE TRIGGER IF NOT EXISTS artifact_delivery_metadata_insert AFTER INSERT ON artifacts
      BEGIN DELETE FROM artifact_delivery_metadata_v1 WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS artifact_delivery_metadata_update AFTER UPDATE ON artifacts
      BEGIN DELETE FROM artifact_delivery_metadata_v1 WHERE id=OLD.id OR id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS artifact_delivery_metadata_delete AFTER DELETE ON artifacts
      BEGIN DELETE FROM artifact_delivery_metadata_v1 WHERE id=OLD.id; END;
    `);
    this.save = db.prepare(`INSERT INTO artifact_delivery_metadata_v1(id,revision,semantic_hash,metadata_json)
      VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
        semantic_hash=excluded.semantic_hash,metadata_json=excluded.metadata_json`);
  }

  write(artifact: Artifact) {
    const metadata = serializeDeliveryArtifactMetadata(artifact);
    this.save.run(artifact.id, artifact.revision, hash(metadata), metadata);
  }

  read(runId: string): DeliveryArtifactRead[] {
    const rows = this.db
      .prepare(
        `
      SELECT a.id,a.run_id,p.metadata_json,p.semantic_hash,
        json_extract(a.data,'$.deliverySemanticHash') expected_hash FROM artifacts a
      LEFT JOIN artifact_delivery_metadata_v1 p ON p.id=a.id AND p.revision=a.revision
        AND p.semantic_hash=json_extract(a.data,'$.deliverySemanticHash')
      WHERE a.run_id=? ORDER BY a.rowid
    `,
      )
      .all(runId) as {
      id: string;
      run_id: string;
      metadata_json: string | null;
      semantic_hash: string | null;
      expected_hash: string | null;
    }[];
    return rows.map((row) => {
      let metadata: DeliveryArtifactMetadata | undefined;
      if (row.metadata_json && hash(row.metadata_json) === row.semantic_hash) {
        try {
          const parsed = JSON.parse(row.metadata_json) as DeliveryArtifactMetadata;
          if (valid(parsed, row.id)) metadata = parsed;
        } catch {
          /* Invalid redundant metadata is rebuilt from the authoritative body. */
        }
      }
      if (!metadata) {
        const artifact = this.readBody(row.id);
        metadata = artifactDeliveryMetadata(artifact);
        if (artifact.runId !== row.run_id || !valid(metadata, row.id))
          throw new Error('Invalid delivery artifact metadata');
        // Most legacy rows already have the right semantic hash. Only repair the source
        // projection when the authoritative body has actually changed or lacks that hash.
        if (hash(serializeDeliveryArtifactMetadata(metadata)) === row.expected_hash) this.write(artifact);
        else this.refresh(artifact);
      }
      return { ...metadata, runId: row.run_id };
    });
  }
}
