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
/**
 * 分段扫描结果：found 携带位置，missing 仅在扫描确认后表示未找到，continue 要求沿 cursor 续读。
 * offset/scannedUntil 使用文件字节范围，line/endLine 是供编辑器展示的行号。
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
