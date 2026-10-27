// 文本定位请求及扫描结果的数据契约。
import type { ResolvedTextEncoding, TextFileEncoding } from './files.js';

// version 和 cursor 用于继续扫描同一文件快照；signal 可取消当前查找。
export type FileLocationOptions = {
  anchor: string;
  encoding?: TextFileEncoding;
  version?: string;
  cursor?: string;
  signal?: AbortSignal;
};
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
