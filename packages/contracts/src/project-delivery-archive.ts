import type { RecordPage } from './run-reads.js';

/** A durable ZIP retained by this local project; saving is separate from acceptance and backup. */
export interface ProjectDeliveryArchive {
  version: 1;
  format: 'zip';
  projectId: string;
  manifestId: string;
  manifestHash: string;
  title: string;
  objectHash: string;
  size: number;
  fileCount: number;
  savedAt: string;
}
export interface ProjectDeliveryArchiveView {
  projectId: string;
  manifestId: string;
  manifestHash: string;
  archive: ProjectDeliveryArchive | null;
}
export interface ProjectDeliveryArchiveList {
  projectId: string;
  items: ProjectDeliveryArchive[];
  count: number;
  totalBytes: number;
  /** Stable identity of the entire retained set, including pages not currently displayed. */
  setHash: string;
  page: RecordPage;
}
