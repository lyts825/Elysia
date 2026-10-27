// 项目文件预览快照及资源读取问题的契约。
/** HTML 预览依赖资源的问题清单；受限、过大和不可读分别报告，不把缺资源当作完整预览。 */
export type PreviewResourceIssue = {
  path?: string;
  reason: 'missing' | 'too-large' | 'unreadable' | 'restricted' | 'not-file';
};
/** 文件目录条目与渲染依赖版本；change 表示相对基线的 Git 变化，renderIssues 另述资源缺口。 */
export type PreviewEntry = {
  path: string;
  size: number;
  modifiedAt: number;
  change: 'A' | 'M' | 'D' | '';
  renderRevision?: number;
  renderTruncated?: boolean;
  renderIssues?: PreviewResourceIssue[];
  renderIssueCount?: number;
};
// 快照关联任务、工作区与基线；truncated 表示文件清单并不完整。
export type PreviewSnapshot = {
  taskId: string;
  workspace: string | null;
  baseline: string | null;
  files: PreviewEntry[];
  revision: string;
  truncated: boolean;
  renderBase: string | null;
};
/**
 * 单文件预览的安全投影：二进制正文为 null，文本可分页；diff 和渲染链接分别读取。
 * deleted 与内容不可读分开表达，分页 version 用于防止不同文件修订混读。
 */
export type PreviewFile = {
  path: string;
  text: string | null;
  hash: string | null;
  mediaType: string;
  kind: 'html' | 'markdown' | 'image' | 'text' | 'binary';
  diff: string;
  diffTruncated: boolean;
  deleted: boolean;
  renderUrl: string | null;
  resourceUrl: string | null;
  resourceBase: string | null;
  page: TextFilePage | null;
  encoding: ResolvedTextEncoding | null;
  encodingSource: 'bom' | 'default' | 'manual' | null;
};
import type { ResolvedTextEncoding, TextFilePage } from './files.js';
