import type { RecordLogStore } from './record-log.service';
import {
  RecordLogEntryRow,
  RecordLogSegmentRow,
  takeWithinBytes
} from './record-log.db';
import type { RecordLogChain } from './record-log-format';

type EntryRow = RecordLogEntryRow & {
  chain: RecordLogChain;
  segment_seq: number | null;
};

/** The record log's tables in memory, for tests. */
export class MemoryRecordLogStore implements RecordLogStore {
  readonly entries: EntryRow[] = [];
  readonly segments: RecordLogSegmentRow[] = [];
  private nextId = 1;

  async insertEntries(
    rows: readonly {
      chain: RecordLogChain;
      lane: string;
      entry: string;
      created_at: number;
    }[]
  ): Promise<void> {
    for (const row of rows) {
      this.entries.push({ ...row, id: this.nextId++, segment_seq: null });
    }
  }

  async findOpenEntries(
    chain: RecordLogChain,
    limit: number,
    maxBytes: number
  ): Promise<RecordLogEntryRow[]> {
    const open = this.entries
      .filter((row) => row.chain === chain && row.segment_seq === null)
      .slice(0, limit);
    const ids = takeWithinBytes(
      open.map((row) => ({
        id: row.id,
        bytes: Buffer.byteLength(row.entry, 'utf8')
      })),
      maxBytes
    );
    return open
      .filter((row) => ids.includes(row.id))
      .map(({ id, lane, entry, created_at }) => ({
        id,
        lane,
        entry,
        created_at
      }));
  }

  private deleteSegmentEntries(chain: RecordLogChain, seq: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (
        this.entries[i].chain === chain &&
        this.entries[i].segment_seq === seq
      ) {
        this.entries.splice(i, 1);
      }
    }
  }

  async findLatestSegment(
    chain: RecordLogChain
  ): Promise<RecordLogSegmentRow | null> {
    const ofChain = this.segments.filter((row) => row.chain === chain);
    return ofChain.length ? ofChain[ofChain.length - 1] : null;
  }

  async insertSegmentClaimingEntries(
    segment: Omit<
      RecordLogSegmentRow,
      'head_drop_id' | 'arweave_tx' | 'archive_drop_id'
    >,
    entryIds: readonly number[]
  ): Promise<void> {
    if (
      this.segments.some(
        (row) => row.chain === segment.chain && row.seq === segment.seq
      )
    ) {
      throw new Error('duplicate segment');
    }
    const claimed = this.entries.filter(
      (row) => entryIds.includes(row.id) && row.segment_seq === null
    );
    if (claimed.length !== entryIds.length) {
      throw new Error('entries were claimed elsewhere');
    }
    claimed.forEach((row) => {
      row.segment_seq = segment.seq;
    });
    this.segments.push({
      ...segment,
      head_drop_id: null,
      arweave_tx: null,
      archive_drop_id: null
    });
  }

  private find(chain: RecordLogChain, seq: number): RecordLogSegmentRow {
    const index = this.segments.findIndex(
      (row) => row.chain === chain && row.seq === seq
    );
    return this.segments[index];
  }

  private update(
    chain: RecordLogChain,
    seq: number,
    changes: Partial<RecordLogSegmentRow>
  ) {
    const index = this.segments.findIndex(
      (row) => row.chain === chain && row.seq === seq
    );
    this.segments[index] = { ...this.find(chain, seq), ...changes };
  }

  async findSegmentsWithoutHead(): Promise<RecordLogSegmentRow[]> {
    return this.segments.filter((row) => row.head_drop_id === null);
  }

  async setHeadDrop(
    chain: RecordLogChain,
    seq: number,
    dropId: string
  ): Promise<void> {
    this.update(chain, seq, { head_drop_id: dropId });
    this.deleteSegmentEntries(chain, seq);
  }

  async findSegmentsToUpload(): Promise<RecordLogSegmentRow[]> {
    return this.segments.filter(
      (row) => row.arweave_tx === null && row.head_drop_id !== null
    );
  }

  async setArweaveTx(
    chain: RecordLogChain,
    seq: number,
    arweaveTx: string
  ): Promise<void> {
    this.update(chain, seq, { arweave_tx: arweaveTx });
  }

  async findSegmentsToAnnounce(): Promise<RecordLogSegmentRow[]> {
    return this.segments.filter(
      (row) => row.arweave_tx !== null && row.archive_drop_id === null
    );
  }

  async setArchiveDrop(
    segments: readonly { chain: RecordLogChain; seq: number }[],
    dropId: string
  ): Promise<void> {
    for (const { chain, seq } of segments) {
      this.update(chain, seq, { archive_drop_id: dropId, content: null });
    }
  }
}
