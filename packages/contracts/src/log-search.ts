// 任务公开终端记录的搜索结果与分页契约。
/** Search only the public transcript artifact belonging to the selected task. */
export interface TerminalLogMatch {
  offset: number;
  endOffset: number;
  before: string;
  match: string;
  after: string;
}
// 返回扫描进度和下一游标，调用方可在当前文件版本上继续查询。
export interface TerminalLogSearchPage {
  /** 限定被搜索的公开日志产物，不可替换为任意文件路径。 */
  artifactId: string;
  query: string;
  version: string;
  totalBytes: number;
  scannedUntil: number;
  /** null 表示扫描结束；有值时仍可能存在当前页未扫描到的匹配。 */
  nextCursor: number | null;
  matches: TerminalLogMatch[];
}
