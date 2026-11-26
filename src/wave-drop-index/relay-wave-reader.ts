import { CrpConnection, CrpItem } from '@/wave-relay-publish/crp-client';
import { checkRelayEvent, RelayEvent, RelayGrant } from './relay-event-check';

/**
 * Reads one wave's log from a relay, oldest first, every event checked as
 * every reader checks it (the rebuild check's RecordsWaveReader: a rebuild
 * walks the "6529.io records" wave's segment heads with it). Events that fail a
 * check are passed to `onRejected` and left out.
 */

export interface RelayWaveEvent {
  readonly rseq: number;
  readonly logEpoch: number;
  readonly event: RelayEvent;
  readonly grant: RelayGrant;
  /** The event and grant exactly as the relay gave them. */
  readonly raw: CrpItem;
}

export interface RecordsWaveReader {
  /** The wave's events after `after` (an rseq; null: from the start). */
  read(wave: string, after?: number | null): AsyncIterable<RelayWaveEvent>;
}

/** What the reader needs of a connection: HIST pages. */
export interface WaveHistorySource {
  history(
    wave: string,
    after: number | null,
    limit: number
  ): Promise<{ logEpoch: number; items: CrpItem[]; more: boolean }>;
}

export class RelayWaveReader implements RecordsWaveReader {
  constructor(
    private readonly connect: () => Promise<
      WaveHistorySource & { close(): void }
    >,
    private readonly onRejected: (rseq: number, reason: string) => void = () =>
      undefined,
    private readonly pageSize = 500
  ) {}

  /** A reader over a relay at `url` on network `net`. */
  static forRelay(url: string, net: string): RelayWaveReader {
    return new RelayWaveReader(() => CrpConnection.open(url, net));
  }

  async *read(
    wave: string,
    after: number | null = null
  ): AsyncIterable<RelayWaveEvent> {
    const connection = await this.connect();
    try {
      // HIST without `after` gives the newest page; from the start is 0.
      let cursor = after ?? 0;
      for (;;) {
        const page = await connection.history(wave, cursor, this.pageSize);
        for (const item of page.items) {
          const check = checkRelayEvent(item.event, item.grant, null);
          if (!check.ok || check.event.wave !== wave) {
            this.onRejected(
              item.rseq,
              check.ok ? 'event of another wave' : check.reason
            );
            continue;
          }
          yield {
            rseq: item.rseq,
            logEpoch: page.logEpoch,
            event: check.event,
            grant: check.grant,
            raw: item
          };
        }
        if (!page.more || !page.items.length) return;
        cursor = page.items[page.items.length - 1].rseq;
      }
    } finally {
      connection.close();
    }
  }
}
