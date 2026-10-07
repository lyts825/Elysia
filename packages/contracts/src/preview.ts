export type PreviewEntry = { path: string; size: number; modifiedAt: number; change: 'A' | 'M' | 'D' | '' };
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
