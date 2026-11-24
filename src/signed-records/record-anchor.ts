import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';

const logger = Logger.get('SIGNED_RECORDS_ANCHOR');

/**
 * Where records take their `anchor`: a finalized chain height. The source is
 * the shared chain gateway client, as signedRecordsChainOf adapts it
 * (record-chain.ts); wireSignedRecordsChainAtStartup sets it at startup.
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

/** The gateway answered, but with no finalized block time to anchor at. */
export class AnchorTimeUnknownError extends Error {
  constructor() {
    super('The chain gateway gave no finalized block time');
    Object.setPrototypeOf(this, AnchorTimeUnknownError.prototype);
    this.name = 'AnchorTimeUnknownError';
  }
}

/**
 * Logs why a chain read failed, once at warn, until a read succeeds again:
 * the cause stays visible without a line per request while the gateway is
 * down.
 */
export class ReadFailureLog {
  private last: string | null = null;

  constructor(
    private readonly log: Pick<Logger, 'warn'>,
    private readonly what: string
  ) {}

  failed(error: unknown): void {
    const code =
      (error as { code?: unknown } | null)?.code ??
      (error as Error | null)?.name ??
      'Error';
    const cause = `[${String(code)}] [${(error as Error | null)?.message ?? String(error)}]`;
    if (cause !== this.last) {
      this.last = cause;
      this.log.warn(`[${this.what}] ${cause}`);
    }
  }

  succeeded(): void {
    this.last = null;
  }
}

export interface RecordAnchor {
  // The height to sign as `anchor`.
  readonly anchor: number;
  readonly headHeight: number;
  readonly finalizedTime: number;
  readonly maxAnchorLag: number;
}

export class RecordAnchorService {
  private source: RecordAnchorSource | null = null;
  private readonly failures = new ReadFailureLog(logger, 'ANCHOR READ FAILED');

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
      this.failures.succeeded();
    } catch (error) {
      this.failures.failed(error);
      // A gateway that is down is the same answer as no gateway: try later.
      throw new CustomApiCompliantException(
        503,
        error instanceof AnchorTimeUnknownError
          ? 'The chain gateway gave no finalized block time, so there is no anchor height'
          : 'The chain gateway did not answer, so there is no anchor height',
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
