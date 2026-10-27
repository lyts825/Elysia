/**
 * 将请求流内容分块存储，并限制单条流的大小。
 * EN: Store request stream text in chunks and enforce a per-stream size limit.
 *
 * 把高频请求输出与最终记录分离，通过分块和体积限制约束写入及回查成本；调用方使用明确位置继续读取。
 * EN: Separate frequent request output from final records and bound write/read cost with chunks and size limits; callers resume from explicit positions.
 */
import type { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AppError } from '../../contracts/src/index.js';

export const REQUEST_STREAM_FORMAT = 'sqlite-chunks-v1';
export const REQUEST_STREAM_CHUNK_CHARS = 4096;
export const REQUEST_STREAM_MAX_CHARS = 8 * 1024 * 1024;

type Stream = { characters: number; chunk_count: number };
type Chunk = { chunk_index: number; characters: number; content: Uint8Array };

/**
 * 持久化请求中正在生成的权威正文；文本提交后才可展示，每次最多重写一个旧尾块。
 * EN: Persist authoritative in-flight text before display. Each append rewrites at most one existing
 * tail chunk.
 */
export class RequestStreams {
  /**
   * 建立请求级长度元数据和按序分块表，外键使清除请求或流记录时同步删除其块。
   * EN: Create request-length metadata and ordered chunks; foreign-key cascades remove chunks with
   * their request or stream record.
   */
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
  /**
   * 创建空流记录；requestId 必须对应已存在的请求。
   * EN: Create an empty stream for an existing requestId.
   */
  start(requestId: string) {
    this.db.prepare('INSERT INTO request_streams_v1 VALUES(?,0,0)').run(requestId);
  }
  /**
   * 按单块的最大 JSON 编码长度限制解压，并核对块声明的字符数与实际文本。
   * EN: Bound decompression by the maximum JSON-encoded chunk size and verify declared versus actual
   * text length.
   */
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
  /**
   * 读取权威长度和块数；流记录缺失意味着持久正文不可证明完整，必须报错。
   * EN: Read authoritative length and chunk count; a missing stream cannot establish complete
   * persisted text and must fail.
   */
  private state(requestId: string): Stream {
    const stream = this.db
      .prepare('SELECT characters,chunk_count FROM request_streams_v1 WHERE request_id=?')
      .get(requestId) as Stream | undefined;
    if (!stream) throw new AppError('REQUEST_STREAM_MISSING', '模型流正文缺失，请保留数据并检查备份');
    return stream;
  }
  /**
   * 按顺序解压并拼接所有分块，检查块序号、数量和字符总数。
   * EN: Decompress and join chunks in order, checking indices, count, and total characters.
   */
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
  /**
   * 在调用方持有的 Store 事务内追加正文。expectedOffset 必须等于已提交字符数，
   * 单次请求正文上限为 8 Mi 个 UTF-16 字符；事务提交前不能发布新文本事件。
   * EN: Append text inside the caller Store transaction. expectedOffset must equal committed character
   * length; one request is limited to 8 Mi UTF-16 units. Publish no new-text event before commit.
   */
  append(requestId: string, text: string, expectedOffset: number) {
    const stream = this.state(requestId);
    // 偏移必须与已提交长度一致，避免并发追加覆盖或重复写入。
    // EN: Require the supplied offset to match committed length, preventing overlapping or repeated
    // appends.
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
    // EN: Rewrite only a partially filled tail; leave all other committed chunks unchanged.
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
    // 保留请求公开版本的递增，而不解压或重写其清单正文。
    // EN: Advance the request public revision without decompressing or rewriting its manifest body.
    this.db
      .prepare(
        "UPDATE requests SET revision=revision+1,data=json_set(data,'$.revision',revision+1) WHERE id=?",
      )
      .run(requestId);
  }
  /**
   * 删除流及其级联分块。
   * EN: Delete a stream and its cascaded chunks.
   */
  clear(requestId: string) {
    this.db.prepare('DELETE FROM request_streams_v1 WHERE request_id=?').run(requestId);
  }
}
