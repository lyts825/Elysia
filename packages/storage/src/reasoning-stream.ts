// 管理推理内容的持久化分块与读取。
import type { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AppError } from '../../contracts/src/index.js';
import {
  REASONING_DISPLAY_MAX_CHARS,
  REASONING_PAGE_MAX_CHARS,
  type ReasoningDisplay,
  type ReasoningKind,
  reasoningPrefixLength,
  splitsReasoningCharacter,
} from '../../contracts/src/reasoning.js';

const CHUNK_CHARS = 4096;
type State = {
  run_id: string;
  request_run_id: string;
  kind: ReasoningKind;
  characters: number;
  received_characters: number;
  complete: number;
  truncated: number;
  request_status: string;
  pending: number;
};
type Chunk = { chunk_index: number; characters: number; content: Uint8Array };
/** 展示缓存损坏使用统一可重试错误，提醒保留权威原文，不能把缺失内容当作空推理。 */
function corrupt(): never {
  throw new AppError('REASONING_UNAVAILABLE', '思考文本暂时无法读取，原始记录已保留。', true, null, 422);
}
/** 推理内容的可选展示缓存；供应商重放和请求计费不依赖此缓存。 */
export class ReasoningStreams {
  /** 建立展示元数据和压缩块；received_characters 跟踪接收量，characters 仅跟踪保留展示量。 */
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS reasoning_streams_v1(
      request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('reasoning_content','summary')),
      characters INTEGER NOT NULL CHECK(characters>=0 AND characters<=${REASONING_DISPLAY_MAX_CHARS}),
      received_characters INTEGER NOT NULL CHECK(received_characters>=characters),
      complete INTEGER NOT NULL CHECK(complete IN (0,1)),
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      pending INTEGER NOT NULL DEFAULT 0 CHECK(pending>=0 AND pending<=65535));
      CREATE INDEX IF NOT EXISTS reasoning_stream_run ON reasoning_streams_v1(run_id,complete);
      CREATE INDEX IF NOT EXISTS reasoning_completed_request ON messages(
        run_id,json_extract(data,'$.conversationLinks.requestId'))
        WHERE json_extract(data,'$.role')='assistant';
      CREATE TABLE IF NOT EXISTS reasoning_stream_chunks_v1(
      request_id TEXT NOT NULL REFERENCES reasoning_streams_v1(request_id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,characters INTEGER NOT NULL,
      content BLOB NOT NULL,PRIMARY KEY(request_id,chunk_index));`);
  }
  /** 同时读取请求状态与缓存归属，供元数据核验和追加资格检查，避免只相信缓存自身的状态。 */
  private state(requestId: string): State | undefined {
    return this.db
      .prepare(
        `SELECT s.*,r.run_id request_run_id,json_extract(r.data,'$.status') request_status
      FROM reasoning_streams_v1 s JOIN requests r ON r.id=s.request_id WHERE s.request_id=?`,
      )
      .get(requestId) as State | undefined;
  }
  /** 读取展示长度和状态，并核验缓存与所属请求的关联。 */
  metadata(requestId: string): ReasoningDisplay | undefined {
    const state = this.state(requestId);
    if (!state || !state.characters) return;
    if (
      state.run_id !== state.request_run_id ||
      !['reasoning_content', 'summary'].includes(state.kind) ||
      !Number.isInteger(state.characters) ||
      state.characters < 0 ||
      state.characters > REASONING_DISPLAY_MAX_CHARS ||
      ![0, 1].includes(state.complete) ||
      ![0, 1].includes(state.truncated)
    )
      corrupt();
    const completed =
      Boolean(state.complete) ||
      (state.request_status === 'SETTLED' &&
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant'
            AND json_extract(data,'$.conversationLinks.requestId')=? LIMIT 1`,
            )
            .get(state.request_run_id, requestId),
        ));
    return {
      kind: state.kind,
      characters: state.characters,
      // A failed final cache write may leave only a prefix of the completed public text.
      truncated: Boolean(state.truncated) || (completed && !state.complete),
      status: completed ? 'complete' : state.request_status === 'RESERVED' ? 'streaming' : 'interrupted',
    };
  }
  /** 有界解压单块并核对实际字符数，防止压缩膨胀或块头与正文不一致。 */
  private decode(row: Chunk): string {
    let text: unknown;
    try {
      text = JSON.parse(gunzipSync(row.content, { maxOutputLength: CHUNK_CHARS * 6 + 2 }).toString('utf8'));
    } catch {
      corrupt();
    }
    if (
      typeof text !== 'string' ||
      text.length !== row.characters ||
      !text.length ||
      text.length > CHUNK_CHARS
    )
      corrupt();
    return text;
  }
  /**
   * 在 Store 事务中追加片段。offset 对应已接收字符数，返回值仅包含本次提交供展示的前缀。
   * 展示容量耗尽后仍记录接收长度；跨片段的代理对暂存，避免截断半个字符。
   */
  append(
    requestId: string,
    text: string,
    offset: number,
    kind: ReasoningKind,
  ): { text: string; offset: number } {
    if (!text.length) return { text: '', offset };
    const request = this.db
      .prepare("SELECT run_id,json_extract(data,'$.status') status FROM requests WHERE id=?")
      .get(requestId);
    if (!request || request.status !== 'RESERVED')
      throw new AppError('REASONING_CLOSED', '模型请求已结束，不能继续追加思考文本');
    let state = this.state(requestId);
    if (!state) {
      if (offset !== 0) throw new AppError('REASONING_OFFSET', '思考文本偏移不连续');
      this.db
        .prepare('INSERT INTO reasoning_streams_v1 VALUES(?,?,?,0,0,0,0,0)')
        .run(requestId, request.run_id, kind);
      state = this.state(requestId)!;
    }
    if (state.received_characters !== offset || state.kind !== kind || state.complete)
      throw new AppError('REASONING_OFFSET', '思考文本偏移不连续');
    const combined = (state.pending ? String.fromCharCode(state.pending) : '') + text,
      room = REASONING_DISPLAY_MAX_CHARS - state.characters;
    const retained = state.truncated ? '' : combined.slice(0, reasoningPrefixLength(combined, room));
    const truncated = Boolean(state.truncated) || combined.length > room;
    const pending = truncated ? 0 : combined.charCodeAt(retained.length) || 0;
    let index = Math.floor(state.characters / CHUNK_CHARS),
      prefix = '';
    if (state.characters % CHUNK_CHARS) {
      const tail = this.db
        .prepare(
          'SELECT chunk_index,characters,content FROM reasoning_stream_chunks_v1 WHERE request_id=? AND chunk_index=?',
        )
        .get(requestId, index) as Chunk | undefined;
      if (!tail) corrupt();
      prefix = this.decode(tail);
      if (prefix.length !== state.characters % CHUNK_CHARS) corrupt();
    }
    for (let start = 0; start < retained.length; ) {
      const count = Math.min(CHUNK_CHARS - prefix.length, retained.length - start);
      const block = prefix + retained.slice(start, start + count);
      this.db
        .prepare(
          `INSERT INTO reasoning_stream_chunks_v1 VALUES(?,?,?,?)
        ON CONFLICT(request_id,chunk_index) DO UPDATE SET characters=excluded.characters,content=excluded.content`,
        )
        .run(requestId, index++, block.length, gzipSync(Buffer.from(JSON.stringify(block)), { level: 1 }));
      start += count;
      prefix = '';
    }
    this.db
      .prepare(
        'UPDATE reasoning_streams_v1 SET characters=?,received_characters=?,truncated=?,pending=? WHERE request_id=?',
      )
      .run(state.characters + retained.length, offset + text.length, Number(truncated), pending, requestId);
    return { text: retained, offset: state.characters };
  }
  /** 用供应商最终公开文本重建展示缓存，原始消息保持不变。 */
  complete(requestId: string, text: string) {
    this.db.prepare('DELETE FROM reasoning_streams_v1 WHERE request_id=?').run(requestId);
    if (!text.length) return;
    const retained = text.slice(0, reasoningPrefixLength(text, REASONING_DISPLAY_MAX_CHARS));
    const request = this.db.prepare('SELECT run_id FROM requests WHERE id=?').get(requestId);
    if (!request) throw new AppError('NOT_FOUND', '模型请求不存在', false, null, 404);
    this.db
      .prepare('INSERT INTO reasoning_streams_v1 VALUES(?,?,?,?,?,1,?,0)')
      .run(
        requestId,
        request.run_id,
        'reasoning_content',
        retained.length,
        text.length,
        Number(text.length > retained.length),
      );
    for (let offset = 0; offset < retained.length; offset += CHUNK_CHARS) {
      const block = retained.slice(offset, offset + CHUNK_CHARS);
      this.db
        .prepare('INSERT INTO reasoning_stream_chunks_v1 VALUES(?,?,?,?)')
        .run(
          requestId,
          offset / CHUNK_CHARS,
          block.length,
          gzipSync(Buffer.from(JSON.stringify(block)), { level: 1 }),
        );
    }
  }
  /** 分页读取完整字符，返回下一页偏移；缺块、损坏或字符中间的偏移会报错。 */
  page(requestId: string, offset: number, limit: number) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > REASONING_DISPLAY_MAX_CHARS ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > REASONING_PAGE_MAX_CHARS
    )
      throw new AppError('REASONING_RANGE', '思考文本读取范围无效');
    const reasoning = this.metadata(requestId);
    if (offset > (reasoning?.characters ?? 0))
      throw new AppError('REASONING_RANGE', '思考文本读取位置已变化，请从头读取');
    if (!reasoning || offset === reasoning.characters)
      return { reasoning: reasoning ?? null, text: '', offset, nextOffset: null };
    const end = Math.min(reasoning.characters, offset + limit),
      first = Math.floor(Math.max(0, offset - 1) / CHUNK_CHARS),
      last = Math.floor(Math.min(reasoning.characters - 1, end) / CHUNK_CHARS);
    const rows = this.db
      .prepare(
        'SELECT chunk_index,characters,content FROM reasoning_stream_chunks_v1 WHERE request_id=? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index',
      )
      .all(requestId, first, last) as Chunk[];
    if (rows.length !== last - first + 1) corrupt();
    const parts = rows.map((row, i) => {
      if (row.chunk_index !== first + i) corrupt();
      if (row.characters !== Math.min(CHUNK_CHARS, reasoning.characters - row.chunk_index * CHUNK_CHARS))
        corrupt();
      return this.decode(row);
    });
    const joined = parts.join(''),
      localOffset = offset - first * CHUNK_CHARS;
    if (splitsReasoningCharacter(joined, localOffset))
      throw new AppError('REASONING_RANGE', '读取位置位于字符中间，请使用上一页返回的位置');
    const safeEnd = reasoningPrefixLength(joined, end - first * CHUNK_CHARS);
    const text = joined.slice(localOffset, safeEnd);
    if (!text.length) throw new AppError('REASONING_RANGE', '页长度不足以读取完整字符');
    if (text.length > end - offset) corrupt();
    const next = offset + text.length;
    return { reasoning, text, offset, nextOffset: next < reasoning.characters ? next : null };
  }
}
