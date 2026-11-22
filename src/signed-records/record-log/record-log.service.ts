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
  RECORD_LOG_ENTRY_MAX_BYTES,
  RecordLogChain,
  RecordLogEntry,
  RecordLogFormatError,
  RecordLogHead,
  RecordLogSegmentHeader,
  sha256Hex
} from './record-log-format';
import type { RecordLogDb } from './record-log.db';
import { readRecordsWave, RecordsWaveReader } from './record-log-reader';

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
  | 'findSegment'
  | 'insertRestoredSegment'
>;

export interface GrantProofSource {
  findGrantProofs(
    grantIds: readonly string[],
    ctx: RequestContext
  ): Promise<RecordGrantProof[]>;
}

/** Adds and pins a file on IPFS (returns its CID), and reads one back. */
export interface ContentPinner {
  pin(bytes: Buffer, name: string): Promise<string>;
  fetch(cid: string): Promise<Buffer>;
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
// Bounds a segment's memory in the loop and its row in MySQL. An entry is at
// most RECORD_LOG_ENTRY_MAX_BYTES, so every entry fits a segment.
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
// An archive drop stays far below the drop size limit at about 150 lines.
const MAX_ARCHIVE_LINES_PER_DROP = 150;

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
      const canonical = canonicalizeJson(checked);
      if (Buffer.byteLength(canonical, 'utf8') > RECORD_LOG_ENTRY_MAX_BYTES) {
        throw new RecordLogFormatError(
          `a log entry is at most ${RECORD_LOG_ENTRY_MAX_BYTES} bytes`
        );
      }
      return {
        chain: chainOfEntry(checked),
        lane: checked.lane,
        entry: canonical,
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
      // The records wave as readers see it, and the wallets that post to it.
      readonly wave: RecordsWaveReader;
      readonly serviceWallets: readonly string[];
      readonly providers: readonly Pick<ProviderKey, 'id' | 'publicKey'>[];
      readonly now?: () => number;
      readonly maxEntriesPerSegment?: number;
      readonly maxSegmentBytes?: number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Closes every chain's open entries into segments, then posts heads.
   * Before opening a segment it restores any head the records wave holds
   * and the segment table lacks, so a chain continues from its real last
   * head even after the table was emptied or restored from an older backup.
   */
  async closeSegments(ctx: RequestContext): Promise<RecordLogHead[]> {
    const closed: RecordLogHead[] = [];
    let restored = false;
    for (const chain of CHAINS) {
      const open = await this.deps.store.findOpenEntries(chain, 1, 1, ctx);
      if (open.length && !restored) {
        await this.restore(ctx);
        restored = true;
      }
      closed.push(...(await this.closeChain(chain, ctx)));
    }
    await this.postHeads(ctx);
    return closed;
  }

  /**
   * Fills the segment table from the records wave: a row for every head
   * the wave holds and the table lacks, with its head drop and, when an
   * archive drop lists it, its Arweave id. A restored row keeps no file
   * (the archiver reads it back from IPFS) and no open or close time (0).
   * Throws, changing nothing more, when a row and the wave's head for the
   * same seq differ: the log has forked and needs a person to look.
   */
  async restore(ctx: RequestContext): Promise<number> {
    const wave = await readRecordsWave(
      this.deps.wave,
      this.deps.serviceWallets
    );
    let restored = 0;
    for (const chain of CHAINS) {
      const { heads, headDrops, archives } = wave[chain];
      for (const head of heads) {
        const row = await this.deps.store.findSegment(chain, head.seq, ctx);
        if (row) {
          if (row.sha256 !== head.sha256) {
            throw new RecordLogFormatError(
              `${chain} segment ${head.seq} differs from its head in the records wave`
            );
          }
          continue;
        }
        const archive = archives.get(head.seq);
        await this.deps.store.insertRestoredSegment(
          {
            chain,
            seq: head.seq,
            sha256: head.sha256,
            cid: head.cid,
            prev: head.prev,
            entries: head.entries,
            opened_at: 0,
            closed_at: 0,
            content: null,
            head_drop_id: headDrops.get(head.seq) ?? null,
            arweave_tx: archive?.arweaveTx ?? null,
            archive_drop_id: archive?.dropId ?? null
          },
          ctx
        );
        restored++;
      }
    }
    if (restored > 0) {
      this.logger.warn(
        `Restored ${restored} segment rows from the records wave`
      );
    }
    return restored;
  }

  private async closeChain(
    chain: RecordLogChain,
    ctx: RequestContext
  ): Promise<RecordLogHead[]> {
    const limit = this.deps.maxEntriesPerSegment ?? MAX_ENTRIES_PER_SEGMENT;
    const maxBytes = this.deps.maxSegmentBytes ?? MAX_SEGMENT_BYTES;
    const heads: RecordLogHead[] = [];
    for (;;) {
      // At most `limit` entries and `maxBytes` of them, never fewer than one.
      const rows = await this.deps.store.findOpenEntries(
        chain,
        limit,
        maxBytes,
        ctx
      );
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
    }
  }

  /**
   * Posts the heads not posted yet, in order; stops a chain at its first
   * failure. A posted head's entries leave the queue: the segment holds them.
   * A head posted again after a crash has the same text, so the drop's
   * client id returns the first drop, and readers take identical heads once.
   */
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
        // Also drops the segment's entries, in the same transaction.
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

  /**
   * Hourly: uploads posted segments to Arweave and lists their ids in
   * archive drops of at most 150 lines each.
   */
  async archive(ctx: RequestContext): Promise<number> {
    for (const segment of await this.deps.store.findSegmentsToUpload(ctx)) {
      // A restored row has no file: read it back from IPFS by its CID.
      const bytes =
        segment.content ?? (await this.deps.pinner.fetch(segment.cid));
      if (sha256Hex(bytes) !== segment.sha256) {
        throw new RecordLogFormatError(
          `${segment.chain} segment ${segment.seq} from IPFS does not match its head`
        );
      }
      const tx = await this.deps.archiver.upload(bytes);
      await this.deps.store.setArweaveTx(segment.chain, segment.seq, tx, ctx);
    }
    const announce = await this.deps.store.findSegmentsToAnnounce(ctx);
    for (let i = 0; i < announce.length; i += MAX_ARCHIVE_LINES_PER_DROP) {
      const batch = announce.slice(i, i + MAX_ARCHIVE_LINES_PER_DROP);
      const dropId = await this.deps.poster.post(
        formatArchiveDrop(
          batch.map((segment) => ({
            chain: segment.chain,
            seq: segment.seq,
            sha256: segment.sha256,
            arweaveTx: segment.arweave_tx ?? ''
          }))
        ),
        ctx
      );
      await this.deps.store.setArchiveDrop(batch, dropId, ctx);
    }
    return announce.length;
  }
}
