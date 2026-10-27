// 任务公开终端记录的搜索结果与分页契约。
/** Search only the public transcript artifact belonging to the selected task. */
export interface TerminalLogMatch {
  offset: number;
  endOffset: number;
  before: string;
  match: string;
  after: string;
}
export interface TerminalLogSearchPage {
  artifactId: string;
  query: string;
  version: string;
  totalBytes: number;
  scannedUntil: number;
  nextCursor: number | null;
  matches: TerminalLogMatch[];
}
