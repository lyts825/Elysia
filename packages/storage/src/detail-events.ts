import { gunzipSync } from 'node:zlib';
import type { Event } from '../../contracts/src/index.js';
import type { EventPreviewCoverage } from '../../contracts/src/run-reads.js';
import type { Store } from './index.js';
import { reasoningMessagePreview } from '../../contracts/src/reasoning.js';

export const DETAIL_EVENT_LIMITS = {
  count: 100,
  bodyBytes: 256 * 1024,
  totalBytes: 2 * 1024 * 1024,
} as const;

/** A bounded, failure-isolated preview; authoritative event and SSE readers are unchanged. */
export function readDetailEvents(
  store: Store,
  runId: string,
): {
  events: Event[];
  eventPreviewCoverage: EventPreviewCoverage;
} {
  const coverage: EventPreviewCoverage = { complete: true, unavailable: 0, limited: false };
  const rows = store.db
    .prepare(
      `SELECT seq,event_id,type,task_id,attempt_id,occurred_at FROM events
      WHERE run_id=? AND seq>MAX(0,(SELECT COALESCE(MAX(seq),0)-100 FROM events WHERE run_id=?))
      ORDER BY seq LIMIT ${DETAIL_EVENT_LIMITS.count}`,
    )
    .all(runId, runId) as {
    seq: number;
    event_id: string;
    type: string;
    task_id: string | null;
    attempt_id: string | null;
    occurred_at: string;
  }[];
  const body = store.db.prepare(`SELECT
    CASE WHEN length(content)<=${DETAIL_EVENT_LIMITS.bodyBytes} THEN content END content,
    CASE WHEN content IS NULL AND length(CAST(payload AS BLOB))<=${DETAIL_EVENT_LIMITS.bodyBytes} THEN payload END payload,
    CASE WHEN content IS NOT NULL THEN length(content)>${DETAIL_EVENT_LIMITS.bodyBytes}
      ELSE length(CAST(payload AS BLOB))>${DETAIL_EVENT_LIMITS.bodyBytes} END oversized
    FROM events WHERE run_id=? AND seq=?`);
  let remaining = DETAIL_EVENT_LIMITS.totalBytes;
  const events = rows.map((row) => {
    let payload: unknown;
    let limited = remaining <= 0;
    try {
      if (limited) throw new Error('Preview budget exhausted');
      const stored = body.get(runId, row.seq) as
        | {
            content: Uint8Array | null;
            payload: string | null;
            oversized: number;
          }
        | undefined;
      if (!stored) throw new Error('Missing event body');
      if (stored.oversized) {
        limited = true;
        throw new Error('Preview body too large');
      }
      let text: string;
      if (stored.content) {
        const budget = Math.min(DETAIL_EVENT_LIMITS.bodyBytes, remaining);
        try {
          const bytes = gunzipSync(stored.content, { maxOutputLength: budget });
          remaining -= bytes.length;
          text = bytes.toString('utf8');
        } catch (error) {
          // A decoder can reject a CRC after expanding the body; charge its full allowance.
          remaining -= budget;
          if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
            limited = true;
          }
          throw error;
        }
      } else {
        if (stored.payload === null) throw new Error('Missing event body');
        const bytes = Buffer.byteLength(stored.payload);
        if (bytes > remaining) {
          limited = true;
          throw new Error('Preview budget exhausted');
        }
        remaining -= bytes;
        text = stored.payload;
      }
      payload = JSON.parse(text);
      if (payload && typeof payload === 'object' && 'externalPayloadRef' in payload)
        throw new Error('External legacy event body');
    } catch {
      coverage.unavailable++;
      coverage.limited ||= limited;
      payload = { detailsOmitted: true, readUnavailable: true };
    }
    if (
      row.type === 'message.completed' &&
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { reasoningContent?: unknown }).reasoningContent === 'string'
    )
      payload = reasoningMessagePreview(payload as { reasoningContent: string });
    return {
      runId,
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      payload,
      occurredAt: row.occurred_at,
    };
  });
  coverage.complete = coverage.unavailable === 0;
  return { events, eventPreviewCoverage: coverage };
}
