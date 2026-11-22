import type { SignedRecordEvent } from '../record-event';
import {
  RecordVerifyContext,
  RecordVerifyResult,
  verifyRecordEvent
} from '../record-verify';
import type { ProviderKey } from '../sealed-crypto';
import {
  parseArchiveDrop,
  parseHeadDrop,
  parseSegmentFile,
  RecordLogChain,
  RecordLogEntry,
  RecordLogFormatError,
  RecordLogHead,
  sha256Hex
} from './record-log-format';

/** A drop of the records wave whose device signature verified. */
export interface RecordsWaveDrop {
  readonly dropId: string;
  // The grant wallet that signed the drop, lowercase.
  readonly author: string;
  readonly text: string;
}

/**
 * The records wave's drops, read from the relays. The waves lane's CRP
 * client provides it; it yields only drops whose signature and grant check.
 */
export interface RecordsWaveReader {
  drops(): AsyncIterable<RecordsWaveDrop>;
}

export interface SegmentFetcher {
  fetchCid(cid: string): Promise<Buffer>;
  fetchArweave(transactionId: string): Promise<Buffer>;
}

export interface RecordLogItem {
  readonly head: RecordLogHead;
  readonly entry: RecordLogEntry;
}

/**
 * Walks a chain of the interim record log from its heads: every head the
 * service identity posted, in seq order, each segment fetched by CID (or
 * from Arweave), checked against its head's sha256 and its predecessor's.
 * Throws on a missing, conflicting or broken link: a rebuild must not
 * silently skip a segment.
 */
export class RecordLogReader {
  constructor(
    private readonly deps: {
      readonly wave: RecordsWaveReader;
      readonly fetcher: SegmentFetcher;
      readonly serviceWallets: readonly string[];
      readonly providers: readonly ProviderKey[];
    }
  ) {}

  private async collect(chain: RecordLogChain): Promise<{
    heads: RecordLogHead[];
    arweave: Map<number, string>;
  }> {
    const wallets = new Set(
      this.deps.serviceWallets.map((wallet) => wallet.toLowerCase())
    );
    const bySeq = new Map<number, RecordLogHead>();
    const arweave = new Map<number, string>();
    for await (const drop of this.deps.wave.drops()) {
      if (!wallets.has(drop.author.toLowerCase())) {
        continue;
      }
      const head = parseHeadDrop(drop.text);
      if (head?.chain === chain) {
        const known = bySeq.get(head.seq);
        if (known && known.sha256 !== head.sha256) {
          throw new RecordLogFormatError(
            `two heads for ${chain} segment ${head.seq}`
          );
        }
        bySeq.set(head.seq, head);
      }
      for (const archive of parseArchiveDrop(drop.text) ?? []) {
        if (archive.chain === chain) {
          arweave.set(archive.seq, archive.arweaveTx);
        }
      }
    }
    const heads = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
    heads.forEach((head, index) => {
      if (head.seq !== index + 1) {
        throw new RecordLogFormatError(
          `${chain} segment ${index + 1} has no head`
        );
      }
      const prev = index === 0 ? null : heads[index - 1].sha256;
      if (head.prev !== prev) {
        throw new RecordLogFormatError(
          `${chain} segment ${head.seq} does not follow its predecessor`
        );
      }
    });
    return { heads, arweave };
  }

  private async fetch(head: RecordLogHead, arweaveTx: string | undefined) {
    let bytes: Buffer | null = null;
    try {
      bytes = await this.deps.fetcher.fetchCid(head.cid);
    } catch (error) {
      if (!arweaveTx) {
        throw error;
      }
    }
    if (bytes === null || sha256Hex(bytes) !== head.sha256) {
      bytes = arweaveTx
        ? await this.deps.fetcher.fetchArweave(arweaveTx)
        : bytes;
    }
    if (bytes === null || sha256Hex(bytes) !== head.sha256) {
      throw new RecordLogFormatError(
        `${head.chain} segment ${head.seq} does not match its head`
      );
    }
    return bytes;
  }

  async *walk(chain: RecordLogChain): AsyncGenerator<RecordLogItem> {
    const { heads, arweave } = await this.collect(chain);
    for (const head of heads) {
      const bytes = await this.fetch(head, arweave.get(head.seq));
      const { header, entries } = parseSegmentFile(bytes, this.deps.providers);
      if (
        header.chain !== chain ||
        header.seq !== head.seq ||
        header.prev !== head.prev ||
        header.entries !== head.entries
      ) {
        throw new RecordLogFormatError(
          `${chain} segment ${head.seq} header does not match its head`
        );
      }
      for (const entry of entries) {
        yield { head, entry };
      }
    }
  }
}

/**
 * Replays a chain for a rebuild: verifies each event entry again (grants and
 * bindings as of its anchor) and hands every entry to the lane's handler.
 */
export async function replayRecordLog(
  reader: RecordLogReader,
  chain: RecordLogChain,
  verifyContext: RecordVerifyContext,
  onEntry: (
    item: RecordLogItem,
    verified: RecordVerifyResult | null
  ) => Promise<void>
): Promise<number> {
  let count = 0;
  for await (const item of reader.walk(chain)) {
    const verified =
      item.entry.t === 'event'
        ? await verifyRecordEvent(
            item.entry.event as SignedRecordEvent,
            verifyContext
          )
        : null;
    await onEntry(item, verified);
    count++;
  }
  return count;
}
