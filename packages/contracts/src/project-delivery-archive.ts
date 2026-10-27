/**
 * 项目交付归档及其读取结果的数据契约。
 * 保存包的身份和分页独立于交付验收，读取元数据不证明文件字节完整。
 *
 * EN: Defines retained project-delivery archives and their read results.
 * Archive identity/paging are separate from acceptance; metadata reads do not prove byte integrity.
 */
import type { RecordPage } from './run-reads.js';

/**
 * 本地项目持久保留的 ZIP；保存与验收、备份是不同操作。
 *
 * EN: A durable ZIP retained by this local project; saving is separate from acceptance and backup.
 */
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
/**
 * 指定清单可能尚无已保存归档，因此 archive 允许为 null。
 *
 * EN: A selected manifest may not yet have a retained archive, so archive may be null.
 */
export interface ProjectDeliveryArchiveView {
  projectId: string;
  manifestId: string;
  manifestHash: string;
  archive: ProjectDeliveryArchive | null;
}
/**
 * 归档分页及全集合指纹；setHash 覆盖未显示页，供批量核对与维护预览绑定。
 *
 * EN: Archive paging with a whole-set fingerprint; setHash covers hidden pages for bulk checks and maintenance-preview binding.
 */
export interface ProjectDeliveryArchiveList {
  projectId: string;
  items: ProjectDeliveryArchive[];
  count: number;
  totalBytes: number;
  /**
   * 整个保留集合的稳定身份，包含当前未显示的页面。
   *
   * EN: Stable identity of the entire retained set, including pages not currently displayed.
   */
  setHash: string;
  page: RecordPage;
}
