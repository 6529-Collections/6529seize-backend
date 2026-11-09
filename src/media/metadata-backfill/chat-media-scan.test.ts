import Sharp from 'sharp';
import { CLOUDFRONT_LINK } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { identifyingJpeg } from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import { BackfillReport } from './backfill-report';
import { SafetyCopyLayout } from './backfill-storage';
import { CdnInvalidator, InvalidationQueue } from './cdn-invalidation';
import {
  ChatMediaBackfillDb,
  DropMediaCandidateRow,
  NonChatDropRow,
  WavePictureRow
} from './chat-media-backfill.db';
import { ChatMediaSource } from './chat-media-candidates';
import { ChatMediaObjectProcessor } from './chat-media-object-processor';
import { ChatMediaScan, ScanOptions } from './chat-media-scan';
import { DecisionEntryExclusions } from './decision-entry-exclusions';

const RUN_ID = '20261116T120000Z-0a1b2c3d';

class FakeDb {
  drops: NonChatDropRow[] = [];
  mediaOfDrops: { drop_id: string; text: string }[] = [];
  candidates: DropMediaCandidateRow[] = [];
  waves: WavePictureRow[] = [];
  archived: WavePictureRow[] = [];

  async findNonChatDropsAfter(after: number, limit: number) {
    return this.drops
      .filter((d) => Number(d.serial_no) > after)
      .slice(0, limit);
  }
  async findCompetitionEntryDropsAfter() {
    return [];
  }
  async findMediaUrlsOfDrops(ids: string[]) {
    return this.mediaOfDrops.filter((m) => ids.includes(m.drop_id));
  }
  async findTextsOfDrops() {
    return [];
  }
  async findUploadsAfter() {
    return [];
  }
  async findMintingClaimMediaAfter() {
    return [];
  }
  async findOrphanDropMediaAfter() {
    return { rows: [], lastId: null };
  }
  async findDropMediaCandidatesAfter(after: number, limit: number) {
    return this.candidates.filter((c) => Number(c.id) > after).slice(0, limit);
  }
  async findWavePicturesAfter(after: number, limit: number) {
    return this.waves
      .filter((w) => Number(w.page_cursor) > after)
      .slice(0, limit);
  }
  async findArchivedWavePicturesAfter(after: number, limit: number) {
    return this.archived
      .filter((w) => Number(w.page_cursor) > after)
      .slice(0, limit);
  }
}

function candidate(
  id: number,
  key: string,
  overrides: Partial<DropMediaCandidateRow> = {}
): DropMediaCandidateRow {
  return {
    id,
    drop_id: `drop-${id}`,
    url: `${CLOUDFRONT_LINK}/${key}`,
    mime_type: 'image/jpeg',
    media_upload_id: null,
    joined_drop_id: `drop-${id}`,
    drop_type: DropType.CHAT,
    reply_to_drop_id: null,
    is_direct_message: 0,
    upload_purpose: null,
    has_competition_entry: 0,
    ...overrides
  };
}

class RecordingInvalidator implements CdnInvalidator {
  readonly paths: string[] = [];
  async invalidate(paths: string[]) {
    this.paths.push(...paths);
  }
}

async function scenario({
  execute,
  options = {}
}: {
  execute: boolean;
  options?: Partial<ScanOptions>;
}) {
  const { jpeg } = await identifyingJpeg();
  const clean = await Sharp({
    create: { width: 4, height: 4, channels: 3, background: '#000' }
  })
    .jpeg()
    .toBuffer();
  const db = new FakeDb();
  const publicStore = new InMemoryObjectStore('public-bucket');
  const safetyStore = new InMemoryObjectStore('private-bucket');
  db.drops = [
    {
      serial_no: 1,
      id: 'entry',
      drop_type: DropType.PARTICIPATORY,
      reply_to_drop_id: null
    }
  ];
  db.mediaOfDrops = [
    { drop_id: 'entry', text: `${CLOUDFRONT_LINK}/drops/e/art.jpg` }
  ];
  db.candidates = [
    candidate(1, 'drops/a/chat.jpg'),
    candidate(2, 'drops/e/art.jpg', {
      drop_id: 'entry',
      joined_drop_id: 'entry',
      drop_type: DropType.PARTICIPATORY
    }),
    candidate(3, 'drops/e/art.jpg'),
    candidate(4, 'drops/b/clean.jpg', {
      reply_to_drop_id: 'entry',
      is_direct_message: 1
    }),
    candidate(5, 'drops/a/chat.jpg'),
    candidate(6, 'drops/c/clip.mp4', { mime_type: 'video/mp4' })
  ];
  db.waves = [
    {
      page_cursor: 1,
      wave_id: 'w1',
      picture: `${CLOUDFRONT_LINK}/waves/author_1/pic.jpg`,
      is_direct_message: 0
    }
  ];
  db.archived = [
    {
      page_cursor: 7,
      wave_id: 'w1',
      picture: `${CLOUDFRONT_LINK}/waves/author_1/old.jpg`,
      is_direct_message: 0
    }
  ];
  for (const key of [
    'drops/a/chat.jpg',
    'drops/e/art.jpg',
    'waves/author_1/pic.jpg',
    'waves/author_1/old.jpg'
  ]) {
    publicStore.seed(key, jpeg, { contentType: 'image/jpeg', metadata: {} });
  }
  publicStore.seed('drops/b/clean.jpg', clean, {
    contentType: 'image/jpeg',
    metadata: {}
  });
  publicStore.seed(
    'drops/c/clip.mp4',
    Buffer.concat([
      Buffer.alloc(100),
      Buffer.from('com.apple.quicktime.location.ISO6709')
    ]),
    { contentType: 'video/mp4', metadata: {} }
  );
  const exclusions = new DecisionEntryExclusions(
    db as unknown as ChatMediaBackfillDb
  );
  await exclusions.build({ collectUploadKeys: false });
  const invalidator = new RecordingInvalidator();
  const invalidations = execute ? new InvalidationQueue(invalidator) : null;
  const report = new BackfillReport(
    RUN_ID,
    'scan',
    execute ? 'execute' : 'dry-run',
    'prod',
    {},
    new Date()
  );
  const processor = new ChatMediaObjectProcessor({
    publicStore,
    writer: execute
      ? {
          safetyStore,
          layout: new SafetyCopyLayout('prod', RUN_ID),
          onRewritten: (paths) => invalidations!.add(paths)
        }
      : null,
    runId: RUN_ID,
    now: () => new Date()
  });
  let random = 0;
  const scan = new ChatMediaScan(
    {
      db: db as unknown as ChatMediaBackfillDb,
      exclusions,
      processor,
      publicStore,
      invalidations,
      report,
      random: () => (random = (random + 0.37) % 1),
      now: Date.now
    },
    {
      limit: null,
      sample: null,
      concurrency: 2,
      resumeAfter: null,
      probeVideos: !execute,
      pageSize: 2,
      exclusionRefreshMillis: 60_000,
      ...options
    }
  );
  return { scan, report, publicStore, safetyStore, invalidator, jpeg };
}

describe('ChatMediaScan', () => {
  it('a dry run counts everything and writes nothing', async () => {
    const { scan, report, publicStore, safetyStore, jpeg } = await scenario({
      execute: false
    });

    expect(await scan.run()).toBe(true);
    report.finish(new Date(), true);
    const json = report.toJSON();

    expect(json.selection.chat_targets).toEqual({ image: 4, video: 1 });
    expect(json.selection.excluded).toEqual({ decision_entry_media: 2 });
    expect(json.keys.excluded.decision_entry_media.keys).toEqual([
      'drops/e/art.jpg',
      'drops/e/art.jpg'
    ]);
    expect(json.selection.duplicate_rows).toBe(1);
    expect(json.selection.chat_in_replies).toBe(1);
    expect(json.selection.chat_in_direct_messages).toBe(1);
    expect(json.objects).toMatchObject({
      inspected: 4,
      to_rewrite: 3,
      rewritten: 0
    });
    expect(json.categories).toMatchObject({ gps: 3, no_metadata: 1 });
    expect(json.videos).toMatchObject({
      chat_videos: 1,
      probed: 1,
      likely_location: 1
    });
    expect(json.next_cursor).toBeNull();
    expect(publicStore.operations.some((op) => op.startsWith('put'))).toBe(
      false
    );
    expect(safetyStore.operations).toEqual([]);
    expect(publicStore.bodyOf('drops/e/art.jpg')!.equals(jpeg)).toBe(true);
  });

  it('an execute run rewrites chat media only and invalidates it', async () => {
    const { scan, report, publicStore, invalidator, jpeg } = await scenario({
      execute: true
    });

    await scan.run();

    expect(report.objects.rewritten).toBe(3);
    expect(publicStore.bodyOf('drops/e/art.jpg')!.equals(jpeg)).toBe(true);
    for (const key of [
      'drops/a/chat.jpg',
      'waves/author_1/pic.jpg',
      'waves/author_1/old.jpg'
    ]) {
      expect(publicStore.bodyOf(key)!.equals(jpeg)).toBe(false);
    }
    expect(invalidator.paths.sort((a, b) => a.localeCompare(b))).toEqual([
      '/drops/a/chat.jpg',
      '/waves/author_1/old.jpg',
      '/waves/author_1/pic.jpg'
    ]);
    expect(report.videos.probed).toBe(0);
  });

  it('stops at --limit with a cursor that resumes after the last row', async () => {
    const first = await scenario({ execute: false, options: { limit: 1 } });
    expect(await first.scan.run()).toBe(false);
    expect(first.report.objects.inspected).toBe(1);
    expect(first.report.nextCursor).toBe('drop_media:1');

    const resumed = await scenario({
      execute: false,
      options: { resumeAfter: { phase: ChatMediaSource.DROP_MEDIA, after: 1 } }
    });
    await resumed.scan.run();
    expect(resumed.report.objects.inspected).toBe(4);
    expect(resumed.report.selection.duplicate_rows).toBe(0);
  });

  it('resumes from a later phase', async () => {
    const { scan, report } = await scenario({
      execute: false,
      options: {
        resumeAfter: { phase: ChatMediaSource.WAVE_PICTURE, after: 1 }
      }
    });
    await scan.run();
    expect(report.selection.rows).toEqual({ archived_wave_picture: 1 });
  });

  it('stops after repeated failures, keeping the last completed cursor', async () => {
    const { scan, report, publicStore } = await scenario({ execute: false });
    publicStore.head = async () => {
      throw new Error('AccessDenied');
    };
    const failing = Array.from({ length: 30 }, (_, index) =>
      candidate(100 + index, `drops/f${index}/x.jpg`)
    );
    (scan as unknown as { deps: { db: FakeDb } }).deps.db.candidates = failing;
    await expect(scan.run()).rejects.toThrow('consecutive failures');
    expect(report.objects.failed).toBeGreaterThanOrEqual(25);
    expect(report.objects.failed).toBeLessThan(30);
  });

  it('--sample processes a random subset and lists it for hand checks', async () => {
    const { scan, report } = await scenario({
      execute: false,
      options: { sample: 2 }
    });
    expect(await scan.run()).toBe(false);
    expect(report.objects.inspected).toBe(2);
    expect(report.samples).toHaveLength(2);
    for (const sample of report.samples) {
      expect([
        'drops/a/chat.jpg',
        'drops/b/clean.jpg',
        'waves/author_1/pic.jpg',
        'waves/author_1/old.jpg'
      ]).toContain(sample.key);
      expect(Object.keys(sample).sort((a, b) => a.localeCompare(b))).toEqual([
        'categories',
        'key',
        'outcome',
        'source'
      ]);
    }
    expect(report.nextCursor).toBeNull();
  });
});
