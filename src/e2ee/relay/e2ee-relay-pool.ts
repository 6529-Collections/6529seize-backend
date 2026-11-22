import {
  CrpConnection,
  CrpError,
  CrpItem,
  CrpSocket,
  openNodeCrpSocket
} from '@/e2ee/relay/e2ee-crp';
import {
  e2eeEd25519Sign,
  E2eeRecordGrantProof,
  E2eeRecordKind,
  E2eeSignedRecordEvent
} from '@/e2ee/relay/e2ee-record-event';
import { E2eeRelayIdentity } from '@/e2ee/relay/e2ee-relay-config';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_RELAY_POOL');

/** The newest events read to find a stream's newest record. */
const NEWEST_PAGE = 32;

/** A record of the stream's hash chain: anything but a DEL (kind 12). */
export function isE2eeChainRecord(item: CrpItem): boolean {
  return item.event.kind !== E2eeRecordKind.DEL;
}
const STREAM_PAGE = 500;
/**
 * A connection is replaced after this long, so its WELCOME `head` (the
 * anchor) stays fresh; re-challenges keep its session alive meanwhile.
 */
const CONNECTION_MAX_AGE_MS = 30 * 60 * 1000;

/** A payload: bytes a record names by their sha256. */
export interface E2eeRelayPayload {
  readonly sha256: string;
  readonly bytes: Buffer;
}

/** One record ready for the relays, with the payloads it names. */
export interface E2eeRelayRecord {
  readonly event: E2eeSignedRecordEvent;
  readonly payloads: readonly E2eeRelayPayload[];
  /** The grant its `auth_ref` names, when not this pool's identity's. */
  readonly grant?: E2eeRecordGrantProof;
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
  private readonly heads = new Map<
    string,
    { readonly head: number; readonly at: number }
  >();

  constructor(
    private readonly options: {
      readonly urls: readonly string[];
      readonly net: string;
      readonly identity: E2eeRelayIdentity;
      readonly open?: E2eeSocketOpener;
      readonly timeoutMs?: number;
      readonly now?: () => number;
    }
  ) {}

  get urls(): readonly string[] {
    return this.options.urls;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The lowest finalized height the relays reported in a recent WELCOME:
   * an anchor no relay is behind. A relay not heard from in two
   * connection lifetimes no longer holds the anchor back.
   */
  get head(): number | null {
    const since = this.now() - 2 * CONNECTION_MAX_AGE_MS;
    const heads = Array.from(this.heads.values())
      .filter((entry) => entry.at >= since)
      .map((entry) => entry.head);
    return heads.length ? Math.min(...heads) : null;
  }

  private async connect(url: string): Promise<CrpConnection> {
    const open = this.options.open ?? openNodeCrpSocket;
    const socket = await open(url);
    const connection = new CrpConnection(
      socket,
      this.options.timeoutMs,
      this.options.now
    );
    const welcome = await connection.hello(this.options.net);
    if (welcome.head !== null) {
      this.heads.set(url, { head: welcome.head, at: this.now() });
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
      const fresh =
        connection !== null &&
        this.now() - connection.openedAt < CONNECTION_MAX_AGE_MS;
      if (connection?.isOpen && fresh) return connection;
      if (connection?.isOpen) connection.close();
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
        const grant = record.grant ?? this.grantFor(record.event);
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

  /**
   * A stream's newest record on one relay, or null when it holds none.
   * DELs are passed over: they sit outside the hash chain and carry none of
   * the stream's content, so the newest event may well be one.
   */
  async newest(url: string, wave: string): Promise<CrpItem | null> {
    const connection = await this.connection(url);
    // HIST without `after` answers the newest page.
    const page = await connection.history(wave, null, NEWEST_PAGE);
    let records = page.items.filter(isE2eeChainRecord);
    if (!records.length && page.items.length >= NEWEST_PAGE) {
      // A whole page of DELs: read the stream from its start.
      records = (await this.stream(url, wave)).filter(isE2eeChainRecord);
    }
    return records[records.length - 1] ?? null;
  }

  /**
   * One page of a family (or stream) from `after` (an rseq), oldest first:
   * how a rebuild finds the streams without holding a whole family.
   */
  async page(
    url: string,
    wave: string,
    after: number,
    limit: number
  ): Promise<{ readonly items: CrpItem[]; readonly more: boolean }> {
    const connection = await this.connection(url);
    return connection.history(wave, after, limit);
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
