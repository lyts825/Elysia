/** 限制事件流缓冲区并编码事件帧。 */
import type { ServerResponse } from 'node:http';

export const eventStreamBufferLimit = 256 * 1024;
export const eventStreamFrameLimit = 64 * 1024;
/** Stop producing when the transport applies backpressure; a stalled client reconnects by event ID. */
export class BoundedEventStream {
  private blocked = false;
  private closed = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private droppedDelta = false;
  constructor(
    private stream: ServerResponse,
    private runId: string,
  ) {
    stream.on('close', () => this.dispose());
    stream.on('drain', () => {
      this.blocked = false;
      clearTimeout(this.timeout);
      if (this.droppedDelta) {
        // 背压期间丢弃增量后，通知客户端重新读取完整运行状态。
        this.droppedDelta = false;
        this.write('event: run.updated\ndata: ' + JSON.stringify({ runId }) + '\n\n');
      }
    });
  }
  get available() {
    return !this.closed && !this.blocked && !this.stream.destroyed;
  }
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
  dispose() {
    this.closed = true;
    clearTimeout(this.timeout);
  }
}

export function eventFrame(event: { seq: number; type: string; runId: string }) {
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (Buffer.byteLength(frame) <= eventStreamFrameLimit) return frame;
  // Large durable bodies remain available through the authenticated snapshot/record APIs.
  return `id: ${event.seq}\nevent: run.updated\ndata: ${JSON.stringify({ seq: event.seq, runId: event.runId, type: 'run.updated', payload: { detailsOmitted: true, eventType: event.type } })}\n\n`;
}
