import { IngestRow, RejectRow } from '@/wave-drop-index/drop-index.db';
import { DropIndexStore } from '@/wave-drop-index/drop-index.subscriber';
import {
  globalWebSocketFactory,
  WebSocketFactory,
  WebSocketLike
} from '@/wave-relay-publish/crp-client';

/**
 * When the relays first held each event, from what they send with it: the
 * earliest of an EV frame's or HIST item's `receipts` (`received_at`, a
 * relay's own receipt), else its `recorded_at` (a recording's first sight).
 *
 * 6529.io's write path refuses a relay event claimed more than 30 days
 * before it was first seen, and checks the grant at that time. Live, the
 * drop index stores the time it read the event; a rebuild reads it later,
 * maybe months later, so it takes the relays' time instead, the closest it
 * has to what live saw. Live behaviour is unchanged: only the rebuild step
 * reads through this.
 */
export class RelayFirstSeen {
  private readonly at = new Map<string, number>();

  /** Notes an EV frame, or each item of a RES frame. */
  noteFrame(frame: Record<string, unknown>): void {
    if (frame.t === 'EV') this.noteItem(frame);
    else if (frame.t === 'RES' && Array.isArray(frame.items)) {
      for (const item of frame.items) {
        if (item && typeof item === 'object') {
          this.noteItem(item as Record<string, unknown>);
        }
      }
    }
  }

  private noteItem(item: Record<string, unknown>): void {
    const event = item.event as { id?: unknown } | undefined;
    const id = typeof event?.id === 'string' ? event.id.toLowerCase() : null;
    const at = firstSeenOfItem(item);
    if (id === null || at === null) return;
    const known = this.at.get(id);
    this.at.set(id, known === undefined ? at : Math.min(known, at));
  }

  of(eventId: string | null): number | undefined {
    return eventId === null ? undefined : this.at.get(eventId.toLowerCase());
  }
}

function asMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** An item's first-seen time: its earliest receipt, else its recorded time. */
export function firstSeenOfItem(item: Record<string, unknown>): number | null {
  const receipts = Array.isArray(item.receipts) ? item.receipts : [];
  const times = receipts
    .map((receipt) =>
      asMillis((receipt as { received_at?: unknown } | null)?.received_at)
    )
    .filter((at): at is number => at !== null);
  if (times.length) return Math.min(...times);
  return asMillis(item.recorded_at);
}

function textOf(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8'
    );
  }
  return null;
}

/**
 * A WebSocket factory that notes each frame's first-seen times before the
 * CRP client reads it; the client gets every frame unchanged.
 */
export function firstSeenFactory(
  firstSeen: RelayFirstSeen,
  inner: WebSocketFactory = globalWebSocketFactory
): WebSocketFactory {
  return (url) => {
    const socket = inner(url);
    const wrapped: WebSocketLike = {
      get readyState() {
        return socket.readyState;
      },
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      addEventListener: (type, listener) =>
        socket.addEventListener(type, (event) => {
          if (type === 'message') {
            const text = textOf(event.data);
            if (text !== null) {
              try {
                firstSeen.noteFrame(JSON.parse(text));
              } catch {
                // Not JSON: the client ignores it too.
              }
            }
          }
          listener(event);
        })
    };
    return wrapped;
  };
}

/**
 * The drop index's store, with each stored row's and reject's
 * `received_at` the relays' first-seen time where they sent one; the
 * run's clock otherwise (a relay that sends no receipt).
 */
export function firstSeenStore(
  inner: DropIndexStore,
  firstSeen: RelayFirstSeen
): DropIndexStore {
  return {
    cursors: (relayId) => inner.cursors(relayId),
    knownGrants: (ids) => inner.knownGrants(ids),
    siteEvents: (ids) => inner.siteEvents(ids),
    ingest: (rows, rejects, relayId, cursors, now) =>
      inner.ingest(
        rows.map(
          (row): IngestRow => ({
            ...row,
            received_at: firstSeen.of(row.event_id) ?? row.received_at
          })
        ),
        rejects.map(
          (reject): RejectRow => ({
            ...reject,
            received_at: firstSeen.of(reject.event_id) ?? reject.received_at
          })
        ),
        relayId,
        cursors,
        now
      )
  };
}
