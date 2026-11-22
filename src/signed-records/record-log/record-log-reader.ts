import type { SignedRecordEvent } from '../record-event';
import {
  GrantProofRecordSource,
  GrantProofSourceOptions
} from '../record-grant-proofs';
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

/** One chain's heads as the records wave holds them. */
export interface RecordsWaveChain {
  // Seq 1 to the last, each following its predecessor.
  readonly heads: RecordLogHead[];
  // The head drop of each seq.
  readonly headDrops: Map<number, string>;
  // The Arweave id of each archived seq, and the archive drop that lists it.
  readonly archives: Map<
    number,
    { readonly arweaveTx: string; readonly dropId: string }
  >;
}

/**
 * Reads the records wave: the head and archive drops the service wallets
 * posted, per chain. Throws on two different heads for one seq, a missing
 * seq or a head that does not follow its predecessor: the log must never
 * be read, or continued, past a fork or a gap.
 */
export async function readRecordsWave(
  wave: RecordsWaveReader,
  serviceWallets: readonly string[]
): Promise<Record<RecordLogChain, RecordsWaveChain>> {
  const wallets = new Set(serviceWallets.map((wallet) => wallet.toLowerCase()));
  const read: Record<
    RecordLogChain,
    {
      bySeq: Map<number, RecordLogHead>;
      headDrops: Map<number, string>;
      archives: RecordsWaveChain['archives'];
    }
  > = {
    public: { bySeq: new Map(), headDrops: new Map(), archives: new Map() },
    private: { bySeq: new Map(), headDrops: new Map(), archives: new Map() }
  };
  for await (const drop of wave.drops()) {
    if (!wallets.has(drop.author.toLowerCase())) {
      continue;
    }
    const head = parseHeadDrop(drop.text);
    if (head) {
      const chain = read[head.chain];
      const known = chain.bySeq.get(head.seq);
      if (known && known.sha256 !== head.sha256) {
        throw new RecordLogFormatError(
          `two heads for ${head.chain} segment ${head.seq}`
        );
      }
      if (!known) {
        chain.bySeq.set(head.seq, head);
        chain.headDrops.set(head.seq, drop.dropId);
      }
    }
    for (const archive of parseArchiveDrop(drop.text) ?? []) {
      read[archive.chain].archives.set(archive.seq, {
        arweaveTx: archive.arweaveTx,
        dropId: drop.dropId
      });
    }
  }
  const chainOf = (chain: RecordLogChain): RecordsWaveChain => {
    const { bySeq, headDrops, archives } = read[chain];
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
    return { heads, headDrops, archives };
  };
  return { public: chainOf('public'), private: chainOf('private') };
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
    const read = await readRecordsWave(
      this.deps.wave,
      this.deps.serviceWallets
    );
    const { heads, archives } = read[chain];
    return {
      heads,
      arweave: new Map(
        Array.from(archives.entries()).map(([seq, it]) => [seq, it.arweaveTx])
      )
    };
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
 * How a replay verifies: the verify context without grants (they come with
 * the entries), plus `contractWallets` (EIP-1271 for grants signed by a
 * contract wallet, read from Ethereum) and `fallback` (a grant source asked
 * when an entry's proof does not verify).
 */
export type RecordReplayContext = Omit<RecordVerifyContext, 'grants' | 'live'> &
  GrantProofSourceOptions;

/**
 * Replays a chain for a rebuild: verifies each event entry again against
 * the grant proof it carries (the wallet signature checked, the proof's id
 * equal to the event's auth_ref), so a rebuild from empty needs no grant
 * table. Grant expiry and revocation are judged at the event's claimed
 * time; the binding to the owner at its anchor. Every entry then goes to
 * the lane's handler; service entries come with `verified = null`.
 */
export async function replayRecordLog(
  reader: RecordLogReader,
  chain: RecordLogChain,
  replayContext: RecordReplayContext,
  onEntry: (
    item: RecordLogItem,
    verified: RecordVerifyResult | null
  ) => Promise<void>
): Promise<number> {
  const { contractWallets, fallback, ...verifyContext } = replayContext;
  let count = 0;
  for await (const item of reader.walk(chain)) {
    const verified =
      item.entry.t === 'event'
        ? await verifyRecordEvent(item.entry.event as SignedRecordEvent, {
            ...verifyContext,
            grants: await GrantProofRecordSource.from([item.entry.grant], {
              contractWallets,
              fallback
            })
          })
        : null;
    await onEntry(item, verified);
    count++;
  }
  return count;
}
