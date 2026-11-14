import { identifyingJpeg } from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import {
  BackfillOriginals,
  MIN_SAFETY_PERIOD_MILLIS
} from './backfill-originals';
import { SafetyCopyLayout } from './backfill-storage';
import { CdnInvalidator, InvalidationQueue } from './cdn-invalidation';
import { ChatMediaSource } from './chat-media-candidates';
import { ChatMediaObjectProcessor } from './chat-media-object-processor';

const RUN_ID = '20261116T120000Z-0a1b2c3d';
const KEY = 'drops/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/6f1c2b3a.jpg';
const OTHER = 'drops/0e9d8c7b-4d5e-4f60-8a7b-9c0d1e2f3a4b/0e9d8c7b.jpg';
const HEADERS = {
  contentType: 'image/jpeg',
  cacheControl: 'public, max-age=31536000, immutable',
  metadata: { 'format-validated': 'true' }
};
const DAY = 24 * 60 * 60 * 1000;
const RUN_TIME = new Date('2026-11-16T12:00:00Z');

class RecordingInvalidator implements CdnInvalidator {
  readonly batches: string[][] = [];
  async invalidate(paths: string[]) {
    this.batches.push(paths);
  }
}

async function rewrittenRun(versioning: 'Disabled' | 'Enabled' = 'Disabled') {
  const { jpeg } = await identifyingJpeg();
  const publicStore = new InMemoryObjectStore('public-bucket');
  publicStore.versioning = versioning;
  const safetyStore = new InMemoryObjectStore('private-bucket');
  const layout = new SafetyCopyLayout('prod', RUN_ID);
  publicStore.seed(KEY, jpeg, HEADERS);
  publicStore.seed(OTHER, jpeg, HEADERS);
  const processor = new ChatMediaObjectProcessor({
    publicStore,
    writer: { safetyStore, layout, onRewritten: () => undefined },
    runId: RUN_ID,
    now: () => RUN_TIME
  });
  for (const key of [KEY, OTHER]) {
    await processor.processImage({
      key,
      kind: 'image',
      source: ChatMediaSource.DROP_MEDIA,
      urls: [],
      inDirectMessage: false,
      isReply: false
    });
  }
  return { jpeg, publicStore, safetyStore, layout };
}

function originals(
  run: Awaited<ReturnType<typeof rewrittenRun>>,
  { execute, now = RUN_TIME }: { execute: boolean; now?: Date }
) {
  const invalidator = new RecordingInvalidator();
  return {
    invalidator,
    originals: new BackfillOriginals({
      publicStore: run.publicStore,
      safetyStore: run.safetyStore,
      layout: run.layout,
      execute,
      invalidations: execute ? new InvalidationQueue(invalidator) : null,
      now: () => now
    })
  };
}

describe('BackfillOriginals.restore', () => {
  it('puts every original back with its headers and invalidates the CDN', async () => {
    const run = await rewrittenRun();
    const { originals: restorer, invalidator } = originals(run, {
      execute: true
    });

    const report = await restorer.restore(null);

    expect(report.counts).toEqual({ restored: 2 });
    for (const key of [KEY, OTHER]) {
      expect(run.publicStore.bodyOf(key)!.equals(run.jpeg)).toBe(true);
      expect(run.publicStore.headersOf(key)).toEqual(HEADERS);
    }
    expect(invalidator.batches).toEqual([[`/${OTHER}`, `/${KEY}`]]);
  });

  it('restores one key on request and is a no-op the second time', async () => {
    const run = await rewrittenRun();
    const { originals: restorer } = originals(run, { execute: true });
    expect((await restorer.restore(KEY)).counts).toEqual({ restored: 1 });
    expect((await restorer.restore(KEY)).counts).toEqual({
      already_original: 1
    });
    expect(run.publicStore.bodyOf(OTHER)!.equals(run.jpeg)).toBe(false);
  });

  it('a dry run only reports', async () => {
    const run = await rewrittenRun();
    const before = run.publicStore.bodyOf(KEY)!;
    const { originals: restorer, invalidator } = originals(run, {
      execute: false
    });
    expect((await restorer.restore(null)).counts).toEqual({ would_restore: 2 });
    expect(run.publicStore.bodyOf(KEY)!.equals(before)).toBe(true);
    expect(invalidator.batches).toEqual([]);
  });

  it('leaves objects changed since the run, and refuses a corrupt copy', async () => {
    const run = await rewrittenRun();
    run.publicStore.seed(KEY, Buffer.from('replaced later'), HEADERS);
    run.safetyStore.seed(
      run.layout.objectKey(OTHER),
      Buffer.from('corrupted'),
      HEADERS
    );
    const { originals: restorer } = originals(run, { execute: true });
    const report = await restorer.restore(null);
    expect(report.counts).toEqual({ changed_since_run: 1, failed: 1 });
    expect(run.publicStore.bodyOf(KEY)!.toString()).toBe('replaced later');
  });
});

describe('BackfillOriginals.invalidate', () => {
  it('re-invalidates only keys that still hold this run’s output', async () => {
    const run = await rewrittenRun();
    run.publicStore.seed(OTHER, Buffer.from('replaced'), HEADERS);
    const { originals: tool, invalidator } = originals(run, { execute: true });
    const report = await tool.invalidate();
    expect(report.counts).toEqual({ invalidated: 1, not_current: 1 });
    expect(invalidator.batches).toEqual([[`/${KEY}`]]);
  });
});

describe('BackfillOriginals.purge', () => {
  it('refuses a safety period shorter than seven days', async () => {
    const run = await rewrittenRun();
    const { originals: purger } = originals(run, { execute: true });
    await expect(
      purger.purge({
        olderThanMillis: 6 * DAY,
        deleteNoncurrentVersions: false
      })
    ).rejects.toThrow('at least 7d');
    expect(run.safetyStore.keys()).toHaveLength(4);
  });

  it('deletes only this run’s originals older than the period', async () => {
    const run = await rewrittenRun();
    const otherRun = new SafetyCopyLayout('prod', '20261101T000000Z-ffffffff');
    run.safetyStore.seed(otherRun.objectKey(KEY), Buffer.from('x'));
    run.safetyStore.setLastModified(
      run.layout.objectKey(OTHER),
      new Date('2026-11-20T00:00:00Z')
    );
    const { originals: purger } = originals(run, {
      execute: true,
      now: new Date(RUN_TIME.getTime() + MIN_SAFETY_PERIOD_MILLIS + DAY)
    });

    const report = await purger.purge({
      olderThanMillis: MIN_SAFETY_PERIOD_MILLIS,
      deleteNoncurrentVersions: false
    });

    expect(report.counts).toEqual({ deleted: 3, kept_too_recent: 1 });
    expect(run.safetyStore.keys().sort((a, b) => a.localeCompare(b))).toEqual(
      [otherRun.objectKey(KEY), run.layout.objectKey(OTHER)].sort((a, b) =>
        a.localeCompare(b)
      )
    );
  });

  it('a dry run deletes nothing', async () => {
    const run = await rewrittenRun();
    const { originals: purger } = originals(run, {
      execute: false,
      now: new Date(RUN_TIME.getTime() + 8 * DAY)
    });
    const report = await purger.purge({
      olderThanMillis: 7 * DAY,
      deleteNoncurrentVersions: false
    });
    expect(report.counts).toEqual({ would_delete: 4 });
    expect(run.safetyStore.keys()).toHaveLength(4);
  });

  it('refuses to delete noncurrent versions on an unversioned bucket', async () => {
    const run = await rewrittenRun('Disabled');
    const { originals: purger } = originals(run, {
      execute: true,
      now: new Date(RUN_TIME.getTime() + 8 * DAY)
    });
    await expect(
      purger.purge({ olderThanMillis: 7 * DAY, deleteNoncurrentVersions: true })
    ).rejects.toThrow('versioning status is Disabled');
    expect(run.safetyStore.keys()).toHaveLength(4);
  });

  it('on a versioned bucket deletes exactly the noncurrent original version', async () => {
    const run = await rewrittenRun('Enabled');
    expect(run.publicStore.versionsOf(KEY)).toHaveLength(2);
    const strippedVersion = run.publicStore.versionsOf(KEY)[1];
    const { originals: purger } = originals(run, {
      execute: true,
      now: new Date(RUN_TIME.getTime() + 8 * DAY)
    });

    const report = await purger.purge({
      olderThanMillis: 7 * DAY,
      deleteNoncurrentVersions: true
    });

    expect(report.counts).toEqual({
      noncurrent_version_deleted: 2,
      deleted: 4
    });
    expect(run.publicStore.versionsOf(KEY)).toEqual([strippedVersion]);
  });
});
