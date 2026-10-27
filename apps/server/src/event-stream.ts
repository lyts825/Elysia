/**
 * 限制事件流缓冲区并编码事件帧。
 * 区分持久可重放事件和临时增量，管理背压及输出预算；丢弃临时片段后提示重读，持久游标只在帧被接受后推进。
 * EN: Bounds event-stream buffering and encodes event frames. Separates durable replayable events from ephemeral deltas under backpressure/output budgets; dropped deltas prompt rereads and accepted frames alone advance durable cursors.
 */
import type { ServerResponse } from 'node:http';

export const eventStreamBufferLimit = 256 * 1024;
export const eventStreamFrameLimit = 64 * 1024;
/**
 * 传输背压时停止产出，停滞客户端按事件ID重连。
 * EN: Stop producing when the transport applies backpressure; a stalled client reconnects by event ID.
 */
export class BoundedEventStream {
  private blocked = false;
  private closed = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private droppedDelta = false;
  /**
   * 绑定 HTTP 响应和运行 ID，监听关闭/排空；背压期间丢失临时增量时补发更新提示，让客户端重读权威状态。
   * EN: Binds response/run and close/drain listeners. After backpressure drops ephemeral deltas, emits an update hint so clients reread authoritative state.
   */
  constructor(
    private stream: ServerResponse,
    private runId: string,
  ) {
    stream.on('close', () => this.dispose());
    stream.on('drain', () => {
      this.blocked = false;
      clearTimeout(this.timeout);
      if (this.droppedDelta) {
        /**
         * 背压期间丢弃增量后，通知客户端重新读取完整运行状态。
         * EN: After deltas are dropped under backpressure, requests a complete state reread by the client.
         */
        this.droppedDelta = false;
        this.write('event: run.updated\ndata: ' + JSON.stringify({ runId }) + '\n\n');
      }
    });
  }
  /**
   * 返回流当前是否可接受输出，综合关闭、背压与底层销毁状态，不改变队列。
   * EN: Reports current write availability from closed, backpressure and destroyed states without mutating queues.
   */
  get available() {
    return !this.closed && !this.blocked && !this.stream.destroyed;
  }
  /**
   * 写入已编码的事件帧。超过单帧或缓冲上限时断开连接；背压时拒绝后续帧并返回 false。 delta 为真时记录丢失的增量，恢复后提示客户端重新读取完整状态。 底层 write 返回 false 的那一帧已被接收，仍返回 true；持久事件调用方可安全推进游标。
   * EN: Writes encoded frames, disconnecting at frame or buffer limits. During backpressure, later frames are rejected with false. Dropped deltas trigger full-state reread after recovery. The frame whose underlying write returns false was accepted, so this method returns true and durable cursors may advance safely.
   */
  write(frame: string, delta = false) {
    if (!this.available) {
      if (delta) this.droppedDelta = true;
      return false;
    }
    if (
      Buffer.byteLength(frame) > eventStreamFrameLimit ||
      this.stream.writableLength + Buffer.byteLength(frame) > eventStreamBufferLimit
    ) {
      this.stream.destroy();
      this.dispose();
      return false;
    }
    if (!this.stream.write(frame)) {
      this.blocked = true;
      this.timeout = setTimeout(() => this.stream.destroy(), 10000);
      this.timeout.unref();
    }
    return true;
  }
  /**
   * 清理内部超时并禁止新帧；响应连接本身由调用方或超时处理负责关闭。
   * EN: Clears internal timeouts and rejects new frames; the caller or timeout handler owns response closure.
   */
  dispose() {
    this.closed = true;
    clearTimeout(this.timeout);
  }
}

/**
 * 使用序号作为 SSE 事件 ID；过大的正文降级为提示客户端回读的更新事件。
 * EN: Uses sequence numbers as SSE IDs; oversized bodies degrade to update notifications that request a full read.
 */
export function eventFrame(event: { seq: number; type: string; runId: string }) {
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (Buffer.byteLength(frame) <= eventStreamFrameLimit) return frame;
  /**
   * 大型持久正文仍可从已认证的快照或记录API读取。
   * EN: Large durable bodies remain available through the authenticated snapshot/record APIs.
   */
  return `id: ${event.seq}\nevent: run.updated\ndata: ${JSON.stringify({ seq: event.seq, runId: event.runId, type: 'run.updated', payload: { detailsOmitted: true, eventType: event.type } })}\n\n`;
}
