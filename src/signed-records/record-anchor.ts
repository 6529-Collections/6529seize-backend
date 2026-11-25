import { CustomApiCompliantException } from '@/exceptions';

/**
 * Where records take their `anchor`: a finalized chain height. The source is
 * the shared chain gateway client (`ChainGatewayClient`,
 * whose `getHead()` has these fields); this interface names that one call so
 * the swap is one line when the client lands.
 */
export interface RecordAnchorSource {
  getHead(): Promise<RecordAnchorHead>;
}

export interface RecordAnchorHead {
  readonly headHeight: number;
  readonly finalizedHeight: number;
  // The finalized block's slot start, Unix ms.
  readonly finalizedTime: number;
}

/**
 * How far behind the finalized head a submitted record's anchor may be:
 * 120 heights, about one hour of 30-second slots (P61 slotMs), the relays'
 * rule for a client's event.
 */
export const MAX_ANCHOR_LAG = 120;

export interface RecordAnchor {
  // The height to sign as `anchor`.
  readonly anchor: number;
  readonly headHeight: number;
  readonly finalizedTime: number;
  readonly maxAnchorLag: number;
}

export class RecordAnchorService {
  private source: RecordAnchorSource | null = null;

  /** Wires the gateway client in (at startup, or a fixture in tests). */
  setSource(source: RecordAnchorSource | null): void {
    this.source = source;
  }

  async getAnchor(): Promise<RecordAnchor> {
    if (!this.source) {
      throw new CustomApiCompliantException(
        503,
        'The chain gateway is not configured, so there is no anchor height',
        'ANCHOR_UNAVAILABLE'
      );
    }
    let head: RecordAnchorHead;
    try {
      head = await this.source.getHead();
    } catch {
      // A gateway that is down is the same answer as no gateway: try later.
      throw new CustomApiCompliantException(
        503,
        'The chain gateway did not answer, so there is no anchor height',
        'ANCHOR_UNAVAILABLE'
      );
    }
    return {
      anchor: head.finalizedHeight,
      headHeight: head.headHeight,
      finalizedTime: head.finalizedTime,
      maxAnchorLag: MAX_ANCHOR_LAG
    };
  }
}

export const recordAnchorService = new RecordAnchorService();
