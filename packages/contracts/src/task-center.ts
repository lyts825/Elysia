import type { Run, Message } from './index.js';
import type { RecordPage } from './run-reads.js';
import type { DeliveryReviewStatus } from './workflow.js';

export type TaskCenterCategory = 'running' | 'waiting' | 'verification' | 'done' | 'failed' | 'paused';
export type TaskCenterItem = {
  id: string;
  title: string;
  projectId: string | null;
  kind: Run['kind'];
  status: Run['status'];
  revision: number;
  category: TaskCenterCategory;
  changeRevision: number;
  reason?: string;
  updatedAt?: string;
  reviewStatus?: DeliveryReviewStatus;
  reviewedAt?: string;
  /** A current meaningful transition, never advanced by title or archive edits. */
  notification?: { status: 'DONE' | 'WAITING' | 'FAILED' | 'UNCERTAIN'; revision: number };
};
export type TaskCenterPage = { items: TaskCenterItem[]; page: RecordPage };
export type TaskCenterChanges = {
  items: { id: string; changeRevision: number; item: TaskCenterItem | null }[];
  cursor: number;
  hasMore: boolean;
  baseline?: boolean;
  resetRequired?: boolean;
};
export type MessageSearchPage = {
  items: { messageId: string; revision: number; role: Message['role']; snippet: string }[];
  page: RecordPage;
};
