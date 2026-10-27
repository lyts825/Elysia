// 将请求流内容分块存储，并限制单条流的大小。
import type { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AppError } from '../../contracts/src/index.js';

export const REQUEST_STREAM_FORMAT = 'sqlite-chunks-v1';
export const REQUEST_STREAM_CHUNK_CHARS = 4096;
export const REQUEST_STREAM_MAX_CHARS = 8 * 1024 * 1024;

type Stream = { characters: number; chunk_count: number };
type Chunk = { chunk_index: number; characters: number; content: Uint8Array };

/** Authoritative in-flight text, committed before display. Each write touches at most one old block. */
export class RequestStreams {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_streams_v1(
        request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
        characters INTEGER NOT NULL CHECK(characters>=0 AND characters<=${REQUEST_STREAM_MAX_CHARS}),
        chunk_count INTEGER NOT NULL CHECK(chunk_count>=0 AND chunk_count<=${REQUEST_STREAM_MAX_CHARS / REQUEST_STREAM_CHUNK_CHARS})
      );
      CREATE TABLE IF NOT EXISTS request_stream_chunks_v1(
        request_id TEXT NOT NULL REFERENCES request_streams_v1(request_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,characters INTEGER NOT NULL,
        content BLOB NOT NULL,PRIMARY KEY(request_id,chunk_index)
      );
    `);
  }
  start(requestId: string) {
    this.db.prepare('INSERT INTO request_streams_v1 VALUES(?,0,0)').run(requestId);
  }
  private decode(row: Chunk): string {
    const text: unknown = JSON.parse(
      gunzipSync(row.content, { maxOutputLength: REQUEST_STREAM_CHUNK_CHARS * 6 + 2 }).toString('utf8'),
    );
    if (
      typeof text !== 'string' ||
      text.length !== row.characters ||
      !text.length ||
      text.length > REQUEST_STREAM_CHUNK_CHARS
    )
      throw new AppError('REQUEST_STREAM_CORRUPT', '模型流正文分块不完整，请保留数据并检查备份');
    return text;
  }
  private state(requestId: string): Stream {
    const stream = this.db
      .prepare('SELECT characters,chunk_count FROM request_streams_v1 WHERE request_id=?')
      .get(requestId) as Stream | undefined;
    if (!stream) throw new AppError('REQUEST_STREAM_MISSING', '模型流正文缺失，请保留数据并检查备份');
    return stream;
  }
  read(requestId: string): string {
    const stream = this.state(requestId);
    const parts: string[] = [];
    let characters = 0;
    for (const row of this.db
      .prepare(
        'SELECT chunk_index,characters,content FROM request_stream_chunks_v1 WHERE request_id=? ORDER BY chunk_index',
      )
      .iterate(requestId) as Iterable<Chunk>) {
      if (row.chunk_index !== parts.length || parts.length >= stream.chunk_count)
        throw new AppError('REQUEST_STREAM_CORRUPT', '模型流正文分块次序不完整');
      const text = this.decode(row);
      parts.push(text);
      characters += text.length;
    }
    if (characters !== stream.characters || parts.length !== stream.chunk_count)
      throw new AppError('REQUEST_STREAM_CORRUPT', '模型流正文长度不完整');
    return parts.join('');
  }
  /** Caller holds the Store transaction; no event may be emitted until it commits. */
  append(requestId: string, text: string, expectedOffset: number) {
    const stream = this.state(requestId);
    // 偏移必须与已提交长度一致，避免并发追加覆盖或重复写入。
    if (stream.characters !== expectedOffset)
      throw new AppError('REQUEST_STREAM_OFFSET', '模型流偏移发生冲突，已保留此前正文');
    if (text.length > REQUEST_STREAM_MAX_CHARS - stream.characters)
      throw new AppError(
        'REQUEST_STREAM_LIMIT',
        '单次模型输出超过 8,388,608 个 UTF-16 字符上限，已停止并保留此前正文；请缩小输出范围后继续',
      );
    const request = this.db
      .prepare("SELECT json_extract(data,'$.status') status FROM requests WHERE id=?")
      .get(requestId);
    if (request?.status !== 'RESERVED')
      throw new AppError('REQUEST_STREAM_CLOSED', '模型请求已结束，不能继续追加正文');
    if (!text.length) return;
    let index = stream.chunk_count;
    let prefix = '';
    // 只重写未满的尾块，其余已提交分块保持不变。
    if (index) {
      const tail = this.db
        .prepare(
          'SELECT chunk_index,characters,content FROM request_stream_chunks_v1 WHERE request_id=? AND chunk_index=?',
        )
        .get(requestId, index - 1) as Chunk | undefined;
      if (!tail) throw new AppError('REQUEST_STREAM_CORRUPT', '模型流尾部分块缺失');
      if (tail.characters < REQUEST_STREAM_CHUNK_CHARS) {
        prefix = this.decode(tail);
        index--;
      }
    }
    let offset = 0;
    while (offset < text.length) {
      const count = Math.min(REQUEST_STREAM_CHUNK_CHARS - prefix.length, text.length - offset);
      const block = prefix + text.slice(offset, offset + count);
      this.db
        .prepare(
          `INSERT INTO request_stream_chunks_v1 VALUES(?,?,?,?)
        ON CONFLICT(request_id,chunk_index) DO UPDATE SET characters=excluded.characters,content=excluded.content`,
        )
        .run(requestId, index++, block.length, gzipSync(Buffer.from(JSON.stringify(block)), { level: 1 }));
      offset += count;
      prefix = '';
    }
    this.db
      .prepare('UPDATE request_streams_v1 SET characters=?,chunk_count=? WHERE request_id=?')
      .run(stream.characters + text.length, index, requestId);
    // Preserve the request's public revision without decompressing or rewriting its manifest.
    this.db
      .prepare(
        "UPDATE requests SET revision=revision+1,data=json_set(data,'$.revision',revision+1) WHERE id=?",
      )
      .run(requestId);
  }
  clear(requestId: string) {
    this.db.prepare('DELETE FROM request_streams_v1 WHERE request_id=?').run(requestId);
  }
}
