import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { RecordGrantProof, SignedRecordEvent } from '../record-event';
import type { ProviderKey } from '../sealed-crypto';
import {
  buildSegmentFile,
  chainOfEntry,
  checkLogEntry,
  formatArchiveDrop,
  formatHeadDrop,
  RecordLogChain,
  RecordLogEntry,
  RecordLogHead,
  RecordLogSegmentHeader,
  sha256Hex
} from './record-log-format';
import type { RecordLogDb } from './record-log.db';

export type RecordLogStore = Pick<
  RecordLogDb,
  | 'insertEntries'
  | 'findOpenEntries'
  | 'findLatestSegment'
  | 'insertSegmentClaimingEntries'
  | 'findSegmentsWithoutHead'
  | 'setHeadDrop'
  | 'findSegmentsToUpload'
  | 'setArweaveTx'
  | 'findSegmentsToAnnounce'
  | 'setArchiveDrop'
>;

export interface GrantProofSource {
  findGrantProofs(
    grantIds: readonly string[],
    ctx: RequestContext
  ): Promise<RecordGrantProof[]>;
}

/** Adds and pins a file on IPFS; returns its CID. */
export interface ContentPinner {
  pin(bytes: Buffer, name: string): Promise<string>;
}

/** Uploads a file to Arweave; returns the transaction id. */
export interface ArweaveArchiver {
  upload(bytes: Buffer): Promise<string>;
}

/** Posts a signed drop by the service identity in the records wave. */
export interface RecordsWavePoster {
  post(text: string, ctx: RequestContext): Promise<string>;
}

const CHAINS: readonly RecordLogChain[] = ['public', 'private'];
const MAX_ENTRIES_PER_SEGMENT = 5000;

/**
 * Appends entries to the open segment. Call it inside the caller's own
 * transaction (ctx.connection), so an entry exists exactly when the write
 * that made it does.
 */
export class RecordLogWriter {
  constructor(
    private readonly store: Pick<RecordLogStore, 'insertEntries'>,
    private readonly grants: GrantProofSource,
    private readonly now: () => number = () => Date.now()
  ) {}

  async append(
    entries: readonly RecordLogEntry[],
    ctx: RequestContext
  ): Promise<void> {
    const createdAt = this.now();
    const rows = entries.map((entry) => {
      const checked = checkLogEntry(entry);
      return {
        chain: chainOfEntry(checked),
        lane: checked.lane,
        entry: canonicalizeJson(checked),
        created_at: createdAt
      };
    });
    await this.store.insertEntries(rows, ctx);
  }

  /** Appends verified events with the proofs of the grants they rely on. */
  async appendEvents(
    lane: string,
    events: readonly SignedRecordEvent[],
    ctx: RequestContext
  ): Promise<void> {
    const ids = Array.from(new Set(events.map((event) => event.auth_ref)));
    const proofs = await this.grants.findGrantProofs(ids, ctx);
    const entries = events.map((event): RecordLogEntry => {
      const grant = proofs.find((proof) => proof.id === event.auth_ref);
      if (!grant) {
        throw new Error(`No grant proof for record ${event.id}`);
      }
      return { t: 'event', lane, event, grant };
    });
    await this.append(entries, ctx);
  }
}

/**
 * Closes segments, posts their heads and archives them. Runs from one
 * scheduled loop at a time; a second runner fails on the segment's key and
 * changes nothing.
 */
export class RecordLogSegmenter {
  private readonly logger = Logger.get(RecordLogSegmenter.name);

  constructor(
    private readonly deps: {
      readonly store: RecordLogStore;
      readonly pinner: ContentPinner;
      readonly archiver: ArweaveArchiver;
      readonly poster: RecordsWavePoster;
      readonly providers: readonly Pick<ProviderKey, 'id' | 'publicKey'>[];
      readonly now?: () => number;
      readonly maxEntriesPerSegment?: number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Closes every chain's open entries into segments, then posts heads. */
  async closeSegments(ctx: RequestContext): Promise<RecordLogHead[]> {
    const closed: RecordLogHead[] = [];
    for (const chain of CHAINS) {
      closed.push(...(await this.closeChain(chain, ctx)));
    }
    await this.postHeads(ctx);
    return closed;
  }

  private async closeChain(
    chain: RecordLogChain,
    ctx: RequestContext
  ): Promise<RecordLogHead[]> {
    const limit = this.deps.maxEntriesPerSegment ?? MAX_ENTRIES_PER_SEGMENT;
    const heads: RecordLogHead[] = [];
    for (;;) {
      const rows = await this.deps.store.findOpenEntries(chain, limit, ctx);
      if (rows.length === 0) {
        return heads;
      }
      const latest = await this.deps.store.findLatestSegment(chain, ctx);
      const header: RecordLogSegmentHeader = {
        t: 'segment',
        v: 1,
        chain,
        seq: (latest?.seq ?? 0) + 1,
        prev: latest?.sha256 ?? null,
        opened_at: rows[0].created_at,
        closed_at: this.now(),
        entries: rows.length
      };
      const entries = rows.map((row) =>
        checkLogEntry(JSON.parse(row.entry) as unknown)
      );
      const bytes = buildSegmentFile({
        header,
        entries,
        providers: this.deps.providers
      });
      const sha256 = sha256Hex(bytes);
      const cid = await this.deps.pinner.pin(
        bytes,
        `6529-records-${chain}-${header.seq}.jsonl`
      );
      await this.deps.store.insertSegmentClaimingEntries(
        {
          chain,
          seq: header.seq,
          sha256,
          cid,
          prev: header.prev,
          entries: rows.length,
          opened_at: header.opened_at,
          closed_at: header.closed_at,
          content: bytes
        },
        rows.map((row) => row.id)
      );
      heads.push({
        chain,
        seq: header.seq,
        sha256,
        cid,
        prev: header.prev,
        entries: rows.length
      });
      if (rows.length < limit) {
        return heads;
      }
    }
  }

  /** Posts the heads not posted yet, in order; stops a chain at its first failure. */
  async postHeads(ctx: RequestContext): Promise<number> {
    const pending = await this.deps.store.findSegmentsWithoutHead(ctx);
    const blocked = new Set<RecordLogChain>();
    let posted = 0;
    for (const segment of pending) {
      if (blocked.has(segment.chain)) {
        continue;
      }
      try {
        const dropId = await this.deps.poster.post(
          formatHeadDrop(segment),
          ctx
        );
        await this.deps.store.setHeadDrop(
          segment.chain,
          segment.seq,
          dropId,
          ctx
        );
        posted++;
      } catch (error) {
        blocked.add(segment.chain);
        this.logger.error(
          `Posting the head of ${segment.chain} segment ${segment.seq} failed`,
          error
        );
      }
    }
    return posted;
  }

  /** Hourly: uploads posted segments to Arweave and lists them in one archive drop. */
  async archive(ctx: RequestContext): Promise<number> {
    for (const segment of await this.deps.store.findSegmentsToUpload(ctx)) {
      if (!segment.content) {
        continue;
      }
      const tx = await this.deps.archiver.upload(segment.content);
      await this.deps.store.setArweaveTx(segment.chain, segment.seq, tx, ctx);
    }
    const announce = await this.deps.store.findSegmentsToAnnounce(ctx);
    if (announce.length === 0) {
      return 0;
    }
    const dropId = await this.deps.poster.post(
      formatArchiveDrop(
        announce.map((segment) => ({
          chain: segment.chain,
          seq: segment.seq,
          sha256: segment.sha256,
          arweaveTx: segment.arweave_tx ?? ''
        }))
      ),
      ctx
    );
    await this.deps.store.setArchiveDrop(announce, dropId, ctx);
    return announce.length;
  }
}
