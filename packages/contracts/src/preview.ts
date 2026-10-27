/**
 * 项目文件预览快照及资源读取问题的契约。
 * HTML 预览依赖资源的问题清单；受限、过大和不可读分别报告，不把缺资源当作完整预览。
 * 冻结快照与当前可读资源分开，读取不完整需要显式呈现，不能伪装成空文件。
 *
 * EN: Defines project-file preview snapshots and resource-read issues.
 * Lists resource problems in an HTML preview, distinguishing restrictions, excessive size, and unreadability rather than calling a missing-resource preview complete.
 * Separates frozen snapshots from readable resources and exposes incomplete reads instead of empty-file fallbacks.
 */
export type PreviewResourceIssue = {
  path?: string;
  reason: 'missing' | 'too-large' | 'unreadable' | 'restricted' | 'not-file';
};
/**
 * 文件目录条目与渲染依赖版本；change 表示相对基线的 Git 变化，renderIssues 另述资源缺口。
 *
 * EN: File entries and rendering-dependency versions; change describes Git changes from the baseline while renderIssues reports resource gaps separately.
 */
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
/**
 * 快照关联任务、工作区与基线；truncated 表示文件清单并不完整。
 *
 * EN: A snapshot binds task, workspace, and baseline; truncated means the file list is incomplete.
 */
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
 *
 * EN: A safe single-file preview projection: binary bodies are null, text can be paged, and diff/render links are read separately. Deletion is distinct from unreadability, and page version prevents mixing file revisions.
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
