export type PreviewResourceIssue = {
  path?: string;
  reason: 'missing' | 'too-large' | 'unreadable' | 'restricted' | 'not-file';
};
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
export type PreviewSnapshot = {
  taskId: string;
  workspace: string | null;
  baseline: string | null;
  files: PreviewEntry[];
  revision: string;
  truncated: boolean;
  renderBase: string | null;
};
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
};
