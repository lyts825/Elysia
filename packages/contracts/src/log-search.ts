/**
 * 任务公开终端记录的搜索结果与分页契约。
 * 仅搜索所选任务所属的公开记录产物。
 * 结果只定位公开日志，不暴露私有协议状态或接受任意磁盘路径。
 *
 * EN: Defines search results and paging for public terminal transcripts.
 * Search only the public transcript artifact belonging to the selected task.
 * Results locate public logs only, never private protocol state or arbitrary disk paths.
 */
export interface TerminalLogMatch {
  offset: number;
  endOffset: number;
  before: string;
  match: string;
  after: string;
}
/**
 * 返回扫描进度和下一游标，调用方可在当前文件版本上继续查询。
 *
 * EN: Returns scan progress and the next cursor so callers can continue within the same file version.
 */
export interface TerminalLogSearchPage {
  /**
   * 限定被搜索的公开日志产物，不可替换为任意文件路径。
   *
   * EN: Restricts search to the identified public-log artifact, not an arbitrary file path.
   */
  artifactId: string;
  query: string;
  version: string;
  totalBytes: number;
  scannedUntil: number;
  /**
   * null 表示扫描结束；有值时仍可能存在当前页未扫描到的匹配。
   *
   * EN: null means scanning ended; otherwise matches may still exist beyond the scanned portion of this page.
   */
  nextCursor: number | null;
  matches: TerminalLogMatch[];
}
