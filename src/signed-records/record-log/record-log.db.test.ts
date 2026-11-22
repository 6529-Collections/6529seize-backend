import 'reflect-metadata';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { describeWithSeed } from '@/tests/_setup/seed';
import { RecordLogDb, takeWithinBytes, toBufferOrNull } from './record-log.db';
import { LocalRecordsWaveReader } from './records-wave-local-reader';

const RECORDS_WAVE = 'records-wave-0000-4000-8000-000000000001';
const SERVICE_PROFILE = 'service-profile-1';
const SERVICE_WALLET = `0x${'5'.repeat(40)}`;

const drop = (
  id: string,
  serialNo: number,
  waveId: string,
  authorId: string
) => ({
  id,
  serial_no: serialNo,
  wave_id: waveId,
  author_id: authorId,
  created_at: 1_000 + serialNo,
  updated_at: null,
  title: null,
  parts_count: 1,
  reply_to_drop_id: null,
  reply_to_part_id: null,
  drop_type: DropType.CHAT,
  signature: null,
  hide_link_preview: true
});

const part = (dropId: string, content: string, waveId: string) => ({
  drop_id: dropId,
  drop_part_id: 1,
  content,
  quoted_drop_id: null,
  quoted_drop_part_id: null,
  wave_id: waveId
});

const ctx: RequestContext = {};

const segment = (seq: number, entries: number) => ({
  chain: 'public' as const,
  seq,
  sha256: `${seq}`.padStart(64, '0'),
  cid: `bafy${'0'.repeat(20)}${seq}`,
  prev: seq === 1 ? null : `${seq - 1}`.padStart(64, '0'),
  entries,
  opened_at: 1000,
  closed_at: 2000,
  content: Buffer.from(`segment ${seq}`)
});

describe('takeWithinBytes', () => {
  it('takes the leading entries within the cap, and always the first', () => {
    const sizes = [
      { id: 1, bytes: 600 },
      { id: 2, bytes: 500 },
      { id: 3, bytes: 100 }
    ];
    expect(takeWithinBytes(sizes, 1100)).toEqual([1, 2]);
    expect(takeWithinBytes(sizes, 100)).toEqual([1]);
    expect(takeWithinBytes([], 100)).toEqual([]);
  });

  it('reads a blob back whether the executor gives a Buffer or its JSON form', () => {
    const bytes = Buffer.from('segment');
    expect(toBufferOrNull(bytes)).toBe(bytes);
    expect(toBufferOrNull(JSON.parse(JSON.stringify(bytes)))).toEqual(bytes);
    expect(toBufferOrNull(null)).toBeNull();
    expect(() => toBufferOrNull('text')).toThrow('neither');
  });
});

describeWithSeed(
  'LocalRecordsWaveReader',
  [
    {
      table: DROPS_TABLE,
      rows: [
        drop('records-drop-2', 12, RECORDS_WAVE, SERVICE_PROFILE),
        drop('records-drop-1', 11, RECORDS_WAVE, SERVICE_PROFILE),
        drop('someone-else', 13, RECORDS_WAVE, 'someone-else'),
        drop('other-wave', 14, 'another-wave', SERVICE_PROFILE)
      ]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        part('records-drop-1', 'head one', RECORDS_WAVE),
        part('records-drop-2', 'head two', RECORDS_WAVE),
        part('someone-else', 'not ours', RECORDS_WAVE),
        part('other-wave', 'elsewhere', 'another-wave')
      ]
    }
  ],
  () => {
    it("reads the service identity's drops in the records wave, oldest first", async () => {
      const reader = new LocalRecordsWaveReader(
        {
          waveId: RECORDS_WAVE,
          profileId: SERVICE_PROFILE,
          wallet: SERVICE_WALLET
        },
        () => sqlExecutor
      );
      const drops = [];
      for await (const it of reader.drops()) {
        drops.push(it);
      }
      expect(drops).toEqual([
        { dropId: 'records-drop-1', author: SERVICE_WALLET, text: 'head one' },
        { dropId: 'records-drop-2', author: SERVICE_WALLET, text: 'head two' }
      ]);
    });
  }
);

describeWithSeed('RecordLogDb', [], () => {
  const db = new RecordLogDb(() => sqlExecutor);

  async function addEntries(count: number, size = 10) {
    await db.insertEntries(
      Array.from({ length: count }, (_, n) => ({
        chain: 'public' as const,
        lane: 'personal',
        entry: `${n}`.padEnd(size, 'x'),
        created_at: 1000 + n
      })),
      ctx
    );
  }

  it('returns open entries in order, within the count and byte caps', async () => {
    await addEntries(5, 100);
    await db.insertEntries(
      [{ chain: 'private', lane: 'dm', entry: 'p', created_at: 1 }],
      ctx
    );
    const all = await db.findOpenEntries('public', 10, 10_000, ctx);
    expect(all.map((row) => row.created_at)).toEqual([
      1000, 1001, 1002, 1003, 1004
    ]);
    expect(await db.findOpenEntries('public', 3, 10_000, ctx)).toHaveLength(3);
    expect(await db.findOpenEntries('public', 10, 250, ctx)).toHaveLength(2);
    expect(await db.findOpenEntries('private', 10, 1, ctx)).toHaveLength(1);
  });

  it('records a segment and claims its entries, or changes nothing', async () => {
    await addEntries(3);
    const open = await db.findOpenEntries('public', 10, 10_000, ctx);
    await db.insertSegmentClaimingEntries(
      segment(1, 2),
      open.slice(0, 2).map((row) => row.id)
    );
    expect(await db.findOpenEntries('public', 10, 10_000, ctx)).toHaveLength(1);
    expect(await db.findLatestSegment('public', ctx)).toMatchObject({
      seq: 1,
      entries: 2,
      head_drop_id: null,
      content: Buffer.from('segment 1')
    });
    // A second closer with the same seq fails and claims nothing.
    await expect(
      db.insertSegmentClaimingEntries(segment(1, 1), [open[2].id])
    ).rejects.toThrow();
    // Entries another closer took fail the claim and roll the segment back.
    await expect(
      db.insertSegmentClaimingEntries(segment(2, 2), [open[0].id, open[2].id])
    ).rejects.toThrow('claimed elsewhere');
    expect(await db.findLatestSegment('public', ctx)).toMatchObject({ seq: 1 });
    expect(await db.findOpenEntries('public', 10, 10_000, ctx)).toHaveLength(1);
  });

  it('finds a segment and inserts a restored one', async () => {
    expect(await db.findSegment('public', 1, ctx)).toBeNull();
    await db.insertRestoredSegment(
      {
        ...segment(1, 3),
        opened_at: 0,
        closed_at: 0,
        content: null,
        head_drop_id: 'drop-1',
        arweave_tx: 'x'.repeat(43),
        archive_drop_id: 'drop-9'
      },
      ctx
    );
    expect(await db.findSegment('public', 1, ctx)).toMatchObject({
      seq: 1,
      content: null,
      head_drop_id: 'drop-1',
      arweave_tx: 'x'.repeat(43),
      archive_drop_id: 'drop-9'
    });
    expect(await db.findLatestSegment('public', ctx)).toMatchObject({ seq: 1 });
    await expect(
      db.insertRestoredSegment(
        {
          ...segment(1, 3),
          content: null,
          head_drop_id: null,
          arweave_tx: null,
          archive_drop_id: null
        },
        ctx
      )
    ).rejects.toThrow();
  });

  it('tracks heads, drops posted entries, and archives', async () => {
    await addEntries(2);
    const open = await db.findOpenEntries('public', 10, 10_000, ctx);
    await db.insertSegmentClaimingEntries(
      segment(1, 2),
      open.map((row) => row.id)
    );
    expect(await db.findSegmentsWithoutHead(ctx)).toHaveLength(1);
    expect(await db.findSegmentsToUpload(ctx)).toHaveLength(0);
    // Setting the head also drops the segment's entries.
    await db.setHeadDrop('public', 1, 'drop-1', ctx);
    const left = await sqlExecutor.execute<{ count: number }>(
      'select count(*) as count from signed_record_log_entries'
    );
    expect(Number(left[0].count)).toBe(0);
    expect(await db.findSegmentsWithoutHead(ctx)).toHaveLength(0);
    expect(await db.findSegmentsToUpload(ctx)).toHaveLength(1);
    await db.setArweaveTx('public', 1, 'x'.repeat(43), ctx);
    const announce = await db.findSegmentsToAnnounce(ctx);
    expect(announce).toMatchObject([{ seq: 1, arweave_tx: 'x'.repeat(43) }]);
    await db.setArchiveDrop(announce, 'drop-2', ctx);
    expect(await db.findSegmentsToAnnounce(ctx)).toHaveLength(0);
    expect(await db.findLatestSegment('public', ctx)).toMatchObject({
      head_drop_id: 'drop-1',
      archive_drop_id: 'drop-2',
      content: null
    });
  });
});
