import type { ResolvedTextEncoding, TextFileEncoding } from './files.js';

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
