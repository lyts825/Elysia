/**
 * 文本定位请求及扫描结果的数据契约。
 * 通过版本和游标绑定增量扫描，避免不同文件修订之间混用定位结果。
 *
 * EN: Defines text-location requests and incremental scan results.
 * Binds incremental scans to a version/cursor to avoid mixing locations from different file revisions.
 */
import type { ResolvedTextEncoding, TextFileEncoding } from './files.js';

/**
 * version 和 cursor 用于继续扫描同一文件快照；signal 可取消当前查找。
 *
 * EN: version and cursor continue scanning the same file snapshot; signal cancels the current lookup.
 */
export type FileLocationOptions = {
  anchor: string;
  encoding?: TextFileEncoding;
  version?: string;
  cursor?: string;
  signal?: AbortSignal;
};
/**
 * 分段扫描结果：found 携带位置，missing 仅在扫描确认后表示未找到，continue 要求沿 cursor 续读。
 * offset/scannedUntil 使用文件字节范围，line/endLine 是供编辑器展示的行号。
 *
 * EN: Incremental results distinguish a found location, a scan-confirmed absence, and continuation via cursor. offset/scannedUntil are byte positions; line/endLine are display line numbers.
 */
export type FileLocation = {
  status: 'found' | 'missing' | 'continue';
  version: string;
  encoding: ResolvedTextEncoding;
  scannedUntil: number;
  totalBytes: number;
  cursor: string | null;
  offset?: number;
  endOffset?: number;
  line?: number;
  endLine?: number;
  anchor?: string;
};
