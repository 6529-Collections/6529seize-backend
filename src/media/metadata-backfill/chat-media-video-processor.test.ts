import { readdir } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoStructureProblem } from '@/media/video-metadata-strip/iso-boxes';
import {
  androidVideo,
  box,
  buildVideo,
  goProVideo,
  IDENTIFYING_STRINGS,
  iphoneVideo,
  videoTrack,
  audioTrack
} from '@/media/video-metadata-strip/fixtures/synthetic-video-fixtures';
import * as verification from '@/media/video-metadata-strip/video-strip-verification';
import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import { BackfillOriginals } from './backfill-originals';
import { SafetyCopyLayout, SafetyCopyManifest } from './backfill-storage';
import { CdnInvalidator, InvalidationQueue } from './cdn-invalidation';
import { ChatMediaSource, ChatMediaTarget } from './chat-media-candidates';
import {
  BACKFILL_RUN_METADATA_KEY,
  ObjectSkipReason
} from './chat-media-object-processor';
import { ChatMediaVideoProcessor } from './chat-media-video-processor';

const RUN_ID = '20261116T120000Z-0a1b2c3d';
const KEY = 'drops/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/6f1c2b3a.mov';
const HEADERS = {
  contentType: 'video/quicktime',
  cacheControl: 'public, max-age=31536000, immutable',
  metadata: {}
};

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'video-backfill-test-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(temp, { recursive: true, force: true });
});

function target(key = KEY): ChatMediaTarget {
  return {
    key,
    kind: 'video',
    source: ChatMediaSource.DROP_MEDIA,
    urls: [`https://d3lqz0a4bldqgf.cloudfront.net/${key}`],
    inDirectMessage: true,
    isReply: false
  };
}

function setup({
  execute,
  maxVideoBytes
}: {
  execute: boolean;
  maxVideoBytes?: number;
}) {
  const publicStore = new InMemoryObjectStore('public-bucket');
  const safetyStore = new InMemoryObjectStore('private-bucket');
  const layout = new SafetyCopyLayout('prod', RUN_ID);
  const invalidated: string[] = [];
  const processor = new ChatMediaVideoProcessor({
    publicStore,
    writer: execute
      ? {
          safetyStore,
          layout,
          onRewritten: (paths) => invalidated.push(...paths)
        }
      : null,
    runId: RUN_ID,
    now: () => new Date('2026-11-16T12:00:00Z'),
    maxVideoBytes,
    tempDirectory: temp
  });
  return { publicStore, safetyStore, layout, invalidated, processor };
}

function expectNoIdentifyingStrings(bytes: Buffer): void {
  for (const value of IDENTIFYING_STRINGS) {
    expect(bytes.includes(Buffer.from(value, 'latin1'))).toBe(false);
  }
}

describe('ChatMediaVideoProcessor', () => {
  it('replaces a chat video with a verified strip after a verified safety copy', async () => {
    const original = goProVideo();
    const { publicStore, safetyStore, layout, invalidated, processor } = setup({
      execute: true
    });
    publicStore.seed(KEY, original, HEADERS);

    const outcome = await processor.processVideo(target());

    expect(outcome).toMatchObject({
      kind: 'rewrite',
      written: true,
      originalSize: original.length,
      findings: expect.arrayContaining(['telemetry_track', 'location'])
    });
    const stripped = publicStore.bodyOf(KEY)!;
    expectNoIdentifyingStrings(stripped);
    expect(publicStore.headersOf(KEY)).toEqual({
      ...HEADERS,
      metadata: {
        'privacy-sanitized': 'true',
        [BACKFILL_RUN_METADATA_KEY]: RUN_ID
      }
    });
    expect(safetyStore.bodyOf(layout.objectKey(KEY))!.equals(original)).toBe(
      true
    );
    const manifest = JSON.parse(
      safetyStore.bodyOf(layout.manifestKey(KEY))!.toString()
    ) as SafetyCopyManifest;
    expect(manifest).toMatchObject({
      public_key: KEY,
      original: { size: original.length },
      stripped: { size: stripped.length },
      headers: HEADERS
    });
    expect(invalidated).toContain(`/${KEY}`);
    expect(await readdir(temp)).toEqual([]);
  });

  it('only reports in a dry run', async () => {
    const { publicStore, safetyStore, processor } = setup({ execute: false });
    publicStore.seed(KEY, iphoneVideo(), HEADERS);

    expect(await processor.processVideo(target())).toMatchObject({
      kind: 'rewrite',
      written: false
    });
    expect(publicStore.bodyOf(KEY)!.equals(iphoneVideo())).toBe(true);
    expect(safetyStore.operations).toEqual([]);
  });

  it('leaves a video without identifying data alone', async () => {
    const clean = buildVideo({
      brand: 'isom',
      creationTime: 0,
      moovFirst: true,
      tracks: [videoTrack({ handlerName: '' }), audioTrack({ handlerName: '' })]
    });
    const { publicStore, safetyStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, clean, HEADERS);

    expect(await processor.processVideo(target())).toEqual({
      kind: 'clean',
      size: clean.length
    });
    expect(publicStore.operations.filter((op) => op.startsWith('put'))).toEqual(
      []
    );
    expect(safetyStore.operations).toEqual([]);
  });

  it.each([
    [
      'fragmented MP4',
      Buffer.concat([
        androidVideo(),
        box('moof', box('mfhd', Buffer.alloc(8)))
      ]),
      ObjectSkipReason.UNSUPPORTED_VIDEO_STRUCTURE,
      VideoStructureProblem.FRAGMENTED
    ],
    [
      'not MP4 at all',
      Buffer.from('RIFF\0\0\0\0AVI LIST', 'latin1'),
      ObjectSkipReason.UNSUPPORTED_FORMAT,
      VideoStructureProblem.NOT_ISO_MEDIA
    ],
    [
      'truncated',
      iphoneVideo().subarray(0, 400),
      ObjectSkipReason.UNPARSEABLE_CONTAINER,
      VideoStructureProblem.MALFORMED
    ]
  ])('skips a %s video and records why', async (_, body, reason, problem) => {
    const { publicStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, body, HEADERS);

    expect(await processor.processVideo(target())).toMatchObject({
      kind: 'skipped',
      reason,
      problem
    });
    expect(publicStore.bodyOf(KEY)!.equals(body)).toBe(true);
  });

  it('skips a strip that does not verify', async () => {
    jest
      .spyOn(verification, 'verifyVideoStrip')
      .mockResolvedValue({ ok: false, reason: 'synthetic failure' });
    const { publicStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, iphoneVideo(), HEADERS);

    expect(await processor.processVideo(target())).toMatchObject({
      kind: 'skipped',
      reason: ObjectSkipReason.VERIFICATION_FAILED,
      findings: expect.arrayContaining(['location'])
    });
    expect(publicStore.bodyOf(KEY)!.equals(iphoneVideo())).toBe(true);
  });

  it('skips missing, content-encoded and oversized videos without reading them', async () => {
    const { publicStore, processor } = setup({
      execute: true,
      maxVideoBytes: 1024
    });
    expect(await processor.processVideo(target())).toMatchObject({
      reason: ObjectSkipReason.MISSING_OBJECT
    });
    publicStore.seed(KEY, iphoneVideo(), {
      ...HEADERS,
      contentEncoding: 'gzip'
    });
    expect(await processor.processVideo(target())).toMatchObject({
      reason: ObjectSkipReason.CONTENT_ENCODED
    });
    publicStore.seed(KEY, iphoneVideo(), HEADERS);
    expect(await processor.processVideo(target())).toMatchObject({
      reason: ObjectSkipReason.TOO_LARGE
    });
    expect(publicStore.operations.filter((op) => op.startsWith('get'))).toEqual(
      []
    );
  });

  it('keeps an object that changed while it was stripped', async () => {
    const { publicStore, safetyStore, layout, processor } = setup({
      execute: true
    });
    publicStore.seed(KEY, iphoneVideo(), HEADERS);
    publicStore.beforePut = (key) => {
      if (key === KEY) publicStore.seed(KEY, androidVideo(), HEADERS);
    };

    expect(await processor.processVideo(target())).toMatchObject({
      kind: 'skipped',
      reason: ObjectSkipReason.CHANGED_DURING_RUN
    });
    expect(publicStore.bodyOf(KEY)!.equals(androidVideo())).toBe(true);
    expect(safetyStore.bodyOf(layout.objectKey(KEY))).toBeDefined();
  });

  it('restores a rewritten video through a temporary file', async () => {
    const original = iphoneVideo();
    const { publicStore, safetyStore, layout, processor } = setup({
      execute: true
    });
    publicStore.seed(KEY, original, HEADERS);
    await processor.processVideo(target());
    const batches: string[][] = [];
    const invalidator: CdnInvalidator = {
      invalidate: async (paths) => {
        batches.push(paths);
      }
    };
    const restore = new BackfillOriginals({
      publicStore,
      safetyStore,
      layout,
      execute: true,
      invalidations: new InvalidationQueue(invalidator),
      now: () => new Date('2026-11-16T13:00:00Z'),
      maxBufferedOriginalBytes: 1024
    });

    const report = await restore.restore(null);

    expect(report.counts).toEqual({ restored: 1 });
    expect(publicStore.bodyOf(KEY)!.equals(original)).toBe(true);
    expect(publicStore.headersOf(KEY)).toEqual(HEADERS);
    expect(batches.flat()).toContain(`/${KEY}`);
  });
});
