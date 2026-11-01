/** 原生收件回执只描述持久接收与上下文纳入，不推断模型已读或完成。
 * EN: Native receipts describe durable receipt/context inclusion, never model acknowledgement or completion.
 */
export interface NativeInboxReceipt {
  id: string;
  revision: number;
  status: 'pending' | 'applied' | 'dismissed';
  receivedAt: string;
  appliedAt?: string;
  intent: 'continue' | 'replan' | 'legacy';
  preview: string;
  truncated: boolean;
  reason: string;
}

export interface NativeInboxReceiptPage {
  runId: string;
  capturedAt: string;
  items: NativeInboxReceipt[];
  pending: number;
  total: number;
  page: { before: string | null; nextBefore: string | null; hasMore: boolean; limit: 20 };
  coverage: { complete: boolean; unavailable: number };
}

export interface NativeInboxReceiptDetail extends NativeInboxReceipt {
  text: string;
}
