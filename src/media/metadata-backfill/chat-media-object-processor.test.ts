import Sharp from 'sharp';
import {
  DROP_MEDIA_SANITIZED_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_VALUE
} from '@/drops/drop-media-upload.config';
import {
  identifyingJpeg,
  identifyingPng,
  IDENTIFYING_STRINGS
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { identifyingUltraHdrJpeg } from '@/media/metadata-strip/fixtures/hdr-image-fixtures';
import {
  describeImageContainer,
  extractJpegGainMaps
} from '@/media/metadata-strip/lossless-metadata-strip';
import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import { SafetyCopyLayout, SafetyCopyManifest } from './backfill-storage';
import { ChatMediaSource, ChatMediaTarget } from './chat-media-candidates';
import {
  BACKFILL_RUN_METADATA_KEY,
  ChatMediaObjectProcessor,
  ObjectSkipReason,
  StripFunction
} from './chat-media-object-processor';
import { CleanState, MetadataCategory } from './metadata-category';

const RUN_ID = '20261116T120000Z-0a1b2c3d';
const KEY = 'drops/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/6f1c2b3a.jpg';
const HEADERS = {
  contentType: 'image/jpeg',
  cacheControl: 'public, max-age=31536000, immutable',
  contentDisposition: 'inline',
  metadata: { 'format-validated': 'true' }
};

function target(key = KEY): ChatMediaTarget {
  return {
    key,
    kind: 'image',
    source: ChatMediaSource.DROP_MEDIA,
    urls: [`https://d3lqz0a4bldqgf.cloudfront.net/${key}`],
    inDirectMessage: false,
    isReply: false
  };
}

function setup({
  execute,
  strip
}: {
  execute: boolean;
  strip?: StripFunction;
}) {
  const publicStore = new InMemoryObjectStore('public-bucket');
  const safetyStore = new InMemoryObjectStore('private-bucket');
  const layout = new SafetyCopyLayout('prod', RUN_ID);
  const invalidated: string[] = [];
  const processor = new ChatMediaObjectProcessor({
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
    strip
  });
  return { publicStore, safetyStore, layout, invalidated, processor };
}

async function cleanJpeg(): Promise<Buffer> {
  return Sharp({
    create: { width: 8, height: 8, channels: 3, background: '#336699' }
  })
    .jpeg()
    .toBuffer();
}

describe('ChatMediaObjectProcessor', () => {
  it('replaces identifying metadata losslessly, keeping headers', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, processor, invalidated } = setup({ execute: true });
    publicStore.seed(KEY, jpeg, HEADERS);

    const outcome = await processor.processImage(target());

    expect(outcome).toMatchObject({ kind: 'rewrite', written: true });
    const stripped = publicStore.bodyOf(KEY)!;
    expect(describeImageContainer(stripped, 'jpeg').metadataBlocks).toEqual([]);
    for (const value of IDENTIFYING_STRINGS) {
      expect(stripped.toString('latin1')).not.toContain(value);
    }
    const before = await Sharp(jpeg).rotate().raw().toBuffer();
    const after = await Sharp(stripped).rotate().raw().toBuffer();
    expect(after.equals(before)).toBe(true);
    expect(publicStore.headersOf(KEY)).toEqual({
      ...HEADERS,
      metadata: {
        'format-validated': 'true',
        [DROP_MEDIA_SANITIZED_METADATA_KEY]:
          DROP_MEDIA_SANITIZED_METADATA_VALUE,
        [BACKFILL_RUN_METADATA_KEY]: RUN_ID
      }
    });
    expect(invalidated).toEqual([`/${KEY}`]);
  });

  it('stores a verified safety copy and manifest before the overwrite', async () => {
    const png = await identifyingPng();
    const { publicStore, safetyStore, layout, processor } = setup({
      execute: true
    });
    const key = KEY.replace('.jpg', '.png');
    const operations: string[] = [];
    publicStore.beforePut = (k) => operations.push(`public ${k}`);
    safetyStore.beforePut = (k) => operations.push(`safety ${k}`);
    publicStore.seed(key, png, { ...HEADERS, contentType: 'image/png' });

    await processor.processImage(target(key));

    expect(operations).toEqual([
      `safety ${layout.objectKey(key)}`,
      `safety ${layout.manifestKey(key)}`,
      `public ${key}`
    ]);
    expect(safetyStore.bodyOf(layout.objectKey(key))!.equals(png)).toBe(true);
    expect(safetyStore.headersOf(layout.objectKey(key))).toEqual({
      ...HEADERS,
      contentType: 'image/png'
    });
    const manifest = JSON.parse(
      safetyStore.bodyOf(layout.manifestKey(key))!.toString('utf8')
    ) as SafetyCopyManifest;
    expect(manifest).toMatchObject({
      version: 1,
      run_id: RUN_ID,
      public_bucket: 'public-bucket',
      public_key: key,
      safety_copy_key: layout.objectKey(key),
      original: { size: png.length, version_id: null },
      headers: { ...HEADERS, contentType: 'image/png' }
    });
    const text = JSON.stringify(manifest);
    for (const value of IDENTIFYING_STRINGS) expect(text).not.toContain(value);
  });

  it('never overwrites when the safety copy cannot be written', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, safetyStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, jpeg, HEADERS);
    safetyStore.beforePut = () => {
      throw new Error('AccessDenied');
    };
    await expect(processor.processImage(target())).rejects.toThrow(
      'AccessDenied'
    );
    expect(publicStore.bodyOf(KEY)!.equals(jpeg)).toBe(true);
  });

  it('skips, without writing, a file the lossless strip cannot verify', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, safetyStore, processor } = setup({
      execute: true,
      strip: async () => ({
        kind: 'unverified',
        reason: 'Decoded digest changed'
      })
    });
    publicStore.seed(KEY, jpeg, HEADERS);

    const outcome = await processor.processImage(target());

    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: ObjectSkipReason.VERIFICATION_FAILED
    });
    expect(outcome.kind === 'skipped' && outcome.categories).toContain(
      MetadataCategory.GPS
    );
    expect(publicStore.bodyOf(KEY)!.equals(jpeg)).toBe(true);
    expect(safetyStore.keys()).toEqual([]);
  });

  it('keeps an HDR gain map, and the result is clean on a second pass', async () => {
    const { jpeg } = await identifyingUltraHdrJpeg();
    const { publicStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, jpeg, HEADERS);

    const outcome = await processor.processImage(target());

    expect(outcome).toMatchObject({
      kind: 'rewrite',
      written: true,
      gainMapsKept: 1
    });
    const stripped = publicStore.bodyOf(KEY)!;
    expect(extractJpegGainMaps(stripped)).toHaveLength(1);
    for (const value of IDENTIFYING_STRINGS) {
      expect(stripped.toString('latin1')).not.toContain(value);
    }
    expect(await processor.processImage(target())).toMatchObject({
      kind: 'clean'
    });
  });

  it('skips a file whose HDR gain map would be dropped', async () => {
    const { jpeg } = await identifyingUltraHdrJpeg({ offsetSkew: 1 });
    const { publicStore, safetyStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, jpeg, HEADERS);

    expect(await processor.processImage(target())).toMatchObject({
      kind: 'skipped',
      reason: ObjectSkipReason.GAIN_MAP_NOT_KEPT
    });
    expect(publicStore.bodyOf(KEY)!.equals(jpeg)).toBe(true);
    expect(safetyStore.keys()).toEqual([]);
  });

  it('leaves clean and orientation-only files untouched', async () => {
    const clean = await cleanJpeg();
    const oriented = await Sharp(clean)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const { publicStore, safetyStore, processor, invalidated } = setup({
      execute: true
    });
    publicStore.seed('drops/a/clean.jpg', clean, HEADERS);
    publicStore.seed('drops/a/oriented.jpg', oriented, HEADERS);

    expect(await processor.processImage(target('drops/a/clean.jpg'))).toEqual({
      kind: 'clean',
      state: CleanState.NO_METADATA,
      size: clean.length
    });
    expect(
      await processor.processImage(target('drops/a/oriented.jpg'))
    ).toMatchObject({
      kind: 'clean',
      state: expect.stringMatching(/orientation_only|technical_exif_only/)
    });
    expect(publicStore.operations.filter((op) => op.startsWith('put'))).toEqual(
      []
    );
    expect(safetyStore.keys()).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it('is idempotent: a second run finds the rewritten file clean', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, safetyStore, processor, invalidated } = setup({
      execute: true
    });
    publicStore.seed(KEY, jpeg, HEADERS);

    await processor.processImage(target());
    const afterFirst = publicStore.bodyOf(KEY)!;
    const safetyKeys = safetyStore.keys();
    const second = await processor.processImage(target());

    expect(second).toMatchObject({ kind: 'clean' });
    expect(publicStore.bodyOf(KEY)!.equals(afterFirst)).toBe(true);
    expect(safetyStore.keys()).toEqual(safetyKeys);
    expect(
      safetyStore
        .bodyOf(safetyKeys.find((k) => k.includes('/objects/'))!)!
        .equals(jpeg)
    ).toBe(true);
    expect(invalidated).toHaveLength(1);
  });

  it('a dry run reads but writes nothing', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, safetyStore, processor } = setup({ execute: false });
    publicStore.seed(KEY, jpeg, HEADERS);

    const outcome = await processor.processImage(target());

    expect(outcome).toMatchObject({ kind: 'rewrite', written: false });
    expect(publicStore.operations).toEqual([`head ${KEY}`, `get ${KEY}`]);
    expect(safetyStore.operations).toEqual([]);
    expect(publicStore.bodyOf(KEY)!.equals(jpeg)).toBe(true);
  });

  it('does not overwrite an object that changed after it was read', async () => {
    const { jpeg } = await identifyingJpeg();
    const { publicStore, processor } = setup({ execute: true });
    publicStore.seed(KEY, jpeg, HEADERS);
    const replacement = await cleanJpeg();
    let replaced = false;
    publicStore.beforePut = () => {
      if (!replaced) {
        replaced = true;
        publicStore.seed(KEY, replacement, HEADERS);
      }
    };

    const outcome = await processor.processImage(target());

    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: ObjectSkipReason.CHANGED_DURING_RUN
    });
    expect(publicStore.bodyOf(KEY)!.equals(replacement)).toBe(true);
  });

  it('skips missing, oversized, encoded and unsupported objects', async () => {
    const { publicStore, processor } = setup({ execute: true });
    const big = new ChatMediaObjectProcessor({
      publicStore,
      writer: null,
      runId: RUN_ID,
      now: () => new Date(),
      maxImageBytes: 10
    });
    publicStore.seed('drops/a/big.jpg', await cleanJpeg());
    publicStore.seed('drops/a/gz.jpg', Buffer.from('x'), {
      contentEncoding: 'gzip'
    });
    publicStore.seed('drops/a/x.avif', Buffer.from('\0\0\0\x1cftypavif0000'));
    publicStore.seed('drops/a/bad.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    const reasons = await Promise.all([
      processor.processImage(target('drops/a/none.jpg')),
      big.processImage(target('drops/a/big.jpg')),
      processor.processImage(target('drops/a/gz.jpg')),
      processor.processImage(target('drops/a/x.avif')),
      processor.processImage(target('drops/a/bad.jpg'))
    ]);
    expect(
      reasons.map((outcome) => outcome.kind === 'skipped' && outcome.reason)
    ).toEqual([
      ObjectSkipReason.MISSING_OBJECT,
      ObjectSkipReason.TOO_LARGE,
      ObjectSkipReason.CONTENT_ENCODED,
      ObjectSkipReason.UNSUPPORTED_FORMAT,
      ObjectSkipReason.UNPARSEABLE_CONTAINER
    ]);
    expect(publicStore.operations.filter((op) => op.startsWith('put'))).toEqual(
      []
    );
  });
});
