import {
  CrpConnection,
  CrpError,
  CrpItem,
  CrpSocket,
  openNodeCrpSocket
} from '@/e2ee/relay/e2ee-crp';
import {
  e2eeEd25519Sign,
  E2eeSignedRecordEvent
} from '@/e2ee/relay/e2ee-record-event';
import { E2eeRelayIdentity } from '@/e2ee/relay/e2ee-relay-config';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_RELAY_POOL');
const STREAM_PAGE = 500;

/** A payload: bytes a record names by their sha256. */
export interface E2eeRelayPayload {
  readonly sha256: string;
  readonly bytes: Buffer;
}

/** One record ready for the relays, with the payloads it names. */
export interface E2eeRelayRecord {
  readonly event: E2eeSignedRecordEvent;
  readonly payloads: readonly E2eeRelayPayload[];
}

/** A relay refused a record for a reason retrying will not fix. */
export class E2eeRelayRejectedError extends Error {
  constructor(
    readonly relay: string,
    readonly eventId: string,
    readonly reason: string
  ) {
    super(`Relay ${relay} refused ${eventId}: ${reason}`);
    this.name = 'E2eeRelayRejectedError';
    Object.setPrototypeOf(this, E2eeRelayRejectedError.prototype);
  }
}

export interface E2eeRelaySequenceResult {
  /** How many leading records of the sequence the relay now holds. */
  readonly held: number;
  readonly error: Error | null;
}

export type E2eeSocketOpener = (url: string) => Promise<CrpSocket>;

/**
 * Connections to the configured relays, one per URL, opened on first use
 * and reused while the process lives. Each connection says HELLO and then
 * AUTHs with the given identity (the orderer to write, the site-reader to
 * read back). A relay's id here is its URL, so the outbox can remember
 * which relays hold which record across restarts.
 */
export class E2eeRelayPool {
  private readonly connections = new Map<string, Promise<CrpConnection>>();
  private lastHead: number | null = null;

  constructor(
    private readonly options: {
      readonly urls: readonly string[];
      readonly net: string;
      readonly identity: E2eeRelayIdentity;
      readonly open?: E2eeSocketOpener;
      readonly timeoutMs?: number;
    }
  ) {}

  get urls(): readonly string[] {
    return this.options.urls;
  }

  /** The highest finalized height a relay reported in its WELCOME. */
  get head(): number | null {
    return this.lastHead;
  }

  private async connect(url: string): Promise<CrpConnection> {
    const open = this.options.open ?? openNodeCrpSocket;
    const socket = await open(url);
    const connection = new CrpConnection(socket, this.options.timeoutMs);
    const welcome = await connection.hello(this.options.net);
    if (welcome.head !== null) {
      this.lastHead = Math.max(this.lastHead ?? 0, welcome.head);
    }
    const identity = this.options.identity;
    await connection.auth({
      grant: identity.grant,
      sign: (digest) => e2eeEd25519Sign(identity.seed, digest),
      net: this.options.net
    });
    return connection;
  }

  async connection(url: string): Promise<CrpConnection> {
    const existing = this.connections.get(url);
    if (existing) {
      const connection = await existing.catch(() => null);
      if (connection?.isOpen) return connection;
    }
    const fresh = this.connect(url);
    this.connections.set(url, fresh);
    fresh.catch(() => this.connections.delete(url));
    return fresh;
  }

  /**
   * Sends records to one relay in order and stops at the first that fails:
   * a stream's records must reach every relay in position order.
   */
  async publishSequence(
    url: string,
    records: readonly E2eeRelayRecord[]
  ): Promise<E2eeRelaySequenceResult> {
    let held = 0;
    try {
      const connection = await this.connection(url);
      for (const record of records) {
        for (const payload of record.payloads) {
          const put = await connection.putPayload(
            payload.sha256,
            payload.bytes
          );
          if (put.status === 'rejected') {
            throw new E2eeRelayRejectedError(
              url,
              payload.sha256,
              put.reason ?? 'payload refused'
            );
          }
        }
        const grant = this.grantFor(record.event);
        if (!grant) throw new Error('No grant for the record');
        const ack = await connection.publish(record.event, grant);
        if (ack.status === 'rejected') {
          throw new E2eeRelayRejectedError(
            url,
            record.event.id,
            ack.reason ?? 'refused'
          );
        }
        held++;
      }
      return { held, error: null };
    } catch (error) {
      if (error instanceof CrpError && error.code !== 'relay') {
        this.connections.delete(url);
      }
      logger.warn(
        `[RELAY ${url}] published ${held} of ${records.length}: ${(error as Error).message}`
      );
      return { held, error: error as Error };
    }
  }

  private grantFor(event: E2eeSignedRecordEvent) {
    const grant = this.options.identity.grant;
    return grant.id === event.auth_ref ? grant : null;
  }

  /** Every event of the given waves or families, from each relay's start. */
  async replay(url: string, waves: readonly string[]): Promise<CrpItem[]> {
    const connection = await this.connection(url);
    const replay = await connection.replay(waves);
    return replay.items;
  }

  /** Every event of one stream on one relay, paged by its rseq. */
  async stream(url: string, wave: string): Promise<CrpItem[]> {
    const connection = await this.connection(url);
    const items: CrpItem[] = [];
    // HIST without `after` answers the newest page; 0 starts at the start.
    let after = 0;
    for (;;) {
      const page = await connection.history(wave, after, STREAM_PAGE);
      items.push(...page.items);
      const last = page.items[page.items.length - 1];
      if (!page.more || !last) break;
      after = last.rseq;
    }
    return items;
  }

  async payload(url: string, sha256: string): Promise<Buffer> {
    const connection = await this.connection(url);
    return connection.getPayload(sha256);
  }

  close() {
    for (const pending of Array.from(this.connections.values())) {
      pending
        .then((connection: CrpConnection) => connection.close())
        .catch(() => undefined);
    }
    this.connections.clear();
  }
}
