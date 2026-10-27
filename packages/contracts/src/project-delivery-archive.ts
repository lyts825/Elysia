// 项目交付归档及其读取结果的数据契约。
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
// 指定清单可能尚无已保存归档，因此 archive 允许为 null。
export interface ProjectDeliveryArchiveView {
  projectId: string;
  manifestId: string;
  manifestHash: string;
  archive: ProjectDeliveryArchive | null;
}
/** 归档分页及全集合指纹；setHash 覆盖未显示页，供批量核对与维护预览绑定。 */
export interface ProjectDeliveryArchiveList {
  projectId: string;
  items: ProjectDeliveryArchive[];
  count: number;
  totalBytes: number;
  /** Stable identity of the entire retained set, including pages not currently displayed. */
  setHash: string;
  page: RecordPage;
}
