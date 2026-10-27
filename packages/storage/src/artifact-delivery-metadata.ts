/**
 * 维护交付产物的元数据读取、序列化与一致性检查。
 * EN: Maintain delivery-artifact metadata reads, canonical serialization, and consistency checks.
 *
 * 规范化元数据后再计算一致性依据，使文件证据读取与保存流程使用同一表示；无法读取或不符的内容由调用方按失败处理。
 * EN: Canonicalize metadata for consistency checks so evidence reads and saves share one representation; callers handle unreadable or mismatched content.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Artifact } from '../../contracts/src/index.js';
import type { DeliveryArtifactMetadata } from '../../contracts/src/workflow.js';
import { hash } from './index.js';

export type DeliveryArtifactRead = DeliveryArtifactMetadata & { runId: string };
export type ArtifactDeliveryWarmBatchResult = {
  scanned: number;
  backfilled: number;
  remaining: number;
  total: number;
};
type MetadataRow = {
  id: string;
  run_id: string;
  metadata_json: string | null;
  semantic_hash: string | null;
  expected_hash: string | null;
};

/**
 * 从产物中抽取影响交付展示与校验的固定字段，不复制完整产物正文。
 * EN: Extract the fixed fields relevant to delivery display and verification without copying the
 * full artifact body.
 */
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

/**
 * 固定七个字段按 stable() 相同的规范键顺序序列化，避免为每个产物重复排序。
 * EN: Serialize the seven fixed fields in the same canonical key order as stable(), without sorting
 * them for every artifact.
 */
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

/**
 * 逐字段比较交付元数据，避免将对象引用相等当作内容相等。
 * EN: Compare delivery metadata field by field rather than treating object identity as content
 * equality.
 */
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

/**
 * 校验投影字段及其行身份，避免仅 JSON 可解析就接受错行或畸形缓存。
 * EN: Validate metadata fields and row identity; parseable JSON alone does not establish a valid
 * cache entry.
 */
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

/**
 * 元数据可从权威正文重建，并由事务内失效规则绑定到原行；旧写入器或其他SQLite连接修复正文时同样清除缓存。
 * EN: Metadata is rebuildable from the authoritative body and bound to its row through
 * transaction-local invalidation. Older writers and other SQLite connections also invalidate it when
 * repairing raw body or data.
 */
export class ArtifactDeliveryMetadataReads {
  private save: StatementSync;
  /**
   * 建立投影与脏队列触发器。readBody 读取权威产物，refresh 用于正文语义已变化的投影修复；
   * 旧库首次建立队列时只登记缺失或版本/语义不匹配的行，不立即解压全部产物。
   * EN: Create projection and dirty-queue triggers. readBody supplies the authoritative artifact and
   * refresh repairs projections when body semantics change. On first initialization, queue only
   * missing or revision/semantic mismatches rather than expanding all artifact bodies.
   */
  constructor(
    private db: DatabaseSync,
    private readBody: (id: string) => Artifact,
    private refresh: (artifact: Artifact) => void,
  ) {
    const queueExists = !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_delivery_metadata_dirty_v1'",
      )
      .get();
    /**
     * 生成内部触发器的脏队列SQL，更新运行归属后补入缺失项；key只来自固定触发器别名。
     * EN: Build internal dirty-queue SQL that refreshes run ownership and inserts missing entries; key comes only from fixed trigger aliases.
     */
    const dirty = (key: string) => `UPDATE artifact_delivery_metadata_dirty_v1
        SET run_id=(SELECT run_id FROM artifacts WHERE id=${key}) WHERE id=${key} AND EXISTS(SELECT 1 FROM artifacts WHERE id=${key});
      INSERT INTO artifact_delivery_metadata_dirty_v1 SELECT id,run_id FROM artifacts WHERE id=${key}
        AND NOT EXISTS(SELECT 1 FROM artifact_delivery_metadata_dirty_v1 WHERE id=${key});`;
    // 正文和投影变化都使缓存失效或加入待修复队列，包括其他 SQLite 连接的写入。
    // EN: Body or projection changes invalidate caches or enqueue repair, including writes from other
    // SQLite connections.
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
      CREATE TABLE IF NOT EXISTS artifact_delivery_metadata_dirty_v1(
        id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,run_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_delivery_metadata_dirty_run ON artifact_delivery_metadata_dirty_v1(run_id);
      DROP TRIGGER IF EXISTS artifact_delivery_dirty_insert;
      DROP TRIGGER IF EXISTS artifact_delivery_dirty_update;
      DROP TRIGGER IF EXISTS artifact_delivery_projection_dirty_insert;
      DROP TRIGGER IF EXISTS artifact_delivery_projection_dirty_update;
      DROP TRIGGER IF EXISTS artifact_delivery_projection_dirty_delete;
      CREATE TRIGGER artifact_delivery_dirty_insert AFTER INSERT ON artifacts
      BEGIN ${dirty('NEW.id')} END;
      CREATE TRIGGER artifact_delivery_dirty_update AFTER UPDATE ON artifacts
      BEGIN ${dirty('NEW.id')} END;
      CREATE TRIGGER IF NOT EXISTS artifact_delivery_dirty_delete AFTER DELETE ON artifacts
      BEGIN DELETE FROM artifact_delivery_metadata_dirty_v1 WHERE id=OLD.id; END;
      CREATE TRIGGER artifact_delivery_projection_dirty_insert AFTER INSERT ON artifact_delivery_metadata_v1
      BEGIN ${dirty('NEW.id')} END;
      CREATE TRIGGER artifact_delivery_projection_dirty_update AFTER UPDATE ON artifact_delivery_metadata_v1
      BEGIN ${dirty('NEW.id')} END;
      CREATE TRIGGER artifact_delivery_projection_dirty_delete AFTER DELETE ON artifact_delivery_metadata_v1
      BEGIN ${dirty('OLD.id')} END;
    `);
    if (!queueExists)
      db.exec(`INSERT OR IGNORE INTO artifact_delivery_metadata_dirty_v1
      SELECT a.id,a.run_id FROM artifacts a LEFT JOIN artifact_delivery_metadata_v1 p ON p.id=a.id
      WHERE p.id IS NULL OR p.revision IS NOT a.revision OR p.semantic_hash IS NOT json_extract(a.data,'$.deliverySemanticHash');`);
    this.save = db.prepare(`INSERT INTO artifact_delivery_metadata_v1(id,revision,semantic_hash,metadata_json)
      VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
        semantic_hash=excluded.semantic_hash,metadata_json=excluded.metadata_json`);
  }

  /**
   * 保存投影；只有字段通过校验时才将该产物从待修复队列移除。
   * EN: Save the projection and remove its dirty-queue entry only when the metadata fields pass
   * validation.
   */
  write(artifact: Artifact) {
    const metadata = serializeDeliveryArtifactMetadata(artifact);
    this.save.run(artifact.id, artifact.revision, hash(metadata), metadata);
    if (valid(artifact, artifact.id))
      this.db.prepare('DELETE FROM artifact_delivery_metadata_dirty_v1 WHERE id=?').run(artifact.id);
  }

  /**
   * 按原始行顺序读取某次运行的产物；无效投影会从权威正文重建。
   * EN: Read artifacts for one run in original row order, rebuilding invalid projections from their
   * authoritative bodies.
   */
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
    return rows.map((row) => this.readRow(row));
  }

  /**
   * 调用方持有短事务；每批最多处理 64 条，正文无法读取时保留队列项供修复。
   * EN: The caller holds a short transaction. Process at most 64 entries per batch and preserve
   * repair-queue entries when bodies cannot be read.
   */
  warmBatch(runId: string, limit = 32): ArtifactDeliveryWarmBatchResult {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new Error('Invalid metadata warm batch limit');
    const rows = this.db
      .prepare(
        `SELECT a.id,a.run_id,p.metadata_json,p.semantic_hash,
        json_extract(a.data,'$.deliverySemanticHash') expected_hash
      FROM artifact_delivery_metadata_dirty_v1 d JOIN artifacts a ON a.id=d.id
      LEFT JOIN artifact_delivery_metadata_v1 p ON p.id=a.id AND p.revision=a.revision
        AND p.semantic_hash=json_extract(a.data,'$.deliverySemanticHash')
      WHERE d.run_id=? ORDER BY d.rowid LIMIT ?`,
      )
      .all(runId, limit) as MetadataRow[];
    let backfilled = 0;
    for (const row of rows) {
      const result = this.readRow(row);
      if (!row.metadata_json || serializeDeliveryArtifactMetadata(result) !== row.metadata_json) backfilled++;
      this.db.prepare('DELETE FROM artifact_delivery_metadata_dirty_v1 WHERE id=?').run(row.id);
    }
    return {
      scanned: rows.length,
      backfilled,
      remaining: Number(
        this.db
          .prepare('SELECT COUNT(*) n FROM artifact_delivery_metadata_dirty_v1 WHERE run_id=?')
          .get(runId)!.n,
      ),
      total: Number(this.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE run_id=?').get(runId)!.n),
    };
  }

  /**
   * 先核对缓存摘要与字段，可信时直接返回；否则用完整产物重新构建。
   * 原正文与 SQL 行的运行归属不一致则失败，不能靠重建投影掩盖错误关联。
   * EN: Check cached digests and fields first, otherwise reconstruct metadata from the full artifact.
   * Reject run-ownership mismatches between body and SQL row instead of hiding them with a rebuilt
   * projection.
   */
  private readRow(row: MetadataRow): DeliveryArtifactRead {
    let metadata: DeliveryArtifactMetadata | undefined;
    if (row.metadata_json && hash(row.metadata_json) === row.semantic_hash) {
      try {
        const parsed = JSON.parse(row.metadata_json) as DeliveryArtifactMetadata;
        if (valid(parsed, row.id)) metadata = parsed;
      } catch {
        // 无效的冗余元数据从权威正文重建。
        // EN: Rebuild invalid redundant metadata from the authoritative body.
      }
    }
    if (!metadata) {
      // 缓存哈希、字段或身份不可信时读取原始产物，不能直接返回缓存。
      // EN: Read the original artifact whenever cached hashes, fields, or identity cannot be trusted; do
      // not return the cache directly.
      const artifact = this.readBody(row.id);
      metadata = artifactDeliveryMetadata(artifact);
      if (artifact.runId !== row.run_id || !valid(metadata, row.id))
        throw new Error('Invalid delivery artifact metadata');
      // 多数旧行的语义哈希已正确；只有权威正文实际变化或缺少该哈希时才修复源投影。
      // EN: Most legacy rows already have the correct semantic hash. Repair the source projection only
      // when the authoritative body changes or lacks that hash.
      if (hash(serializeDeliveryArtifactMetadata(metadata)) === row.expected_hash) this.write(artifact);
      else this.refresh(artifact);
    }
    return { ...metadata, runId: row.run_id };
  }
}
