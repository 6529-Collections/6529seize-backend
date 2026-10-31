import {
  deleteLegacyDmMedia,
  isExactOrVariant,
  mediaKeyFromUrl,
  mediaTargetsFromManifest,
  targetForKey,
  type LegacyDmObjectStore,
  type LegacyDmObjectVersion
} from './legacy-dm-media';

const CDN = 'https://d3lqz0a4bldqgf.cloudfront.net';
const UUID = '0b2b1c4e-1111-4222-8333-944455556666';

describe('mediaKeyFromUrl', () => {
  it('maps 6529 CDN URLs to keys and ignores other hosts', () => {
    expect(mediaKeyFromUrl(`${CDN}/drops/${UUID}/a%20b.png?d=1`)).toBe(
      `drops/${UUID}/a b.png`
    );
    expect(mediaKeyFromUrl('https://ipfs.io/ipfs/bafy')).toBeNull();
    expect(mediaKeyFromUrl(`${CDN}/`)).toBeNull();
    expect(mediaKeyFromUrl(`${CDN}/%E0%A4%A`)).toBeNull();
  });
});

describe('targetForKey', () => {
  it('deletes a per-upload drop directory whole, other keys exactly', () => {
    expect(targetForKey('img', `drops/${UUID}/a.png`, true)).toEqual({
      bucket: 'img',
      key: `drops/${UUID}/`,
      scope: 'prefix',
      cdnPath: `/drops/${UUID}/*`
    });
    expect(targetForKey('img', 'waves/author_p1/a.png', true)).toEqual({
      bucket: 'img',
      key: 'waves/author_p1/a.png',
      scope: 'exact',
      cdnPath: '/waves/author_p1/a.png'
    });
    expect(targetForKey('img', 'drops/not-a-uuid/a.png', false).scope).toBe(
      'exact'
    );
  });
});

describe('isExactOrVariant', () => {
  it('matches the key and one-level resized variants only', () => {
    const key = 'waves/author_p1/a.png';
    expect(isExactOrVariant(key, key)).toBe(true);
    expect(isExactOrVariant(key, 'waves/author_p1/300x300_max/a.png')).toBe(
      true
    );
    expect(isExactOrVariant(key, 'waves/author_p1/x/y/a.png')).toBe(false);
    expect(isExactOrVariant(key, 'waves/author_p1/b.png')).toBe(false);
    expect(isExactOrVariant(key, 'waves/author_p1/aa.png')).toBe(false);
  });
});

describe('mediaTargetsFromManifest', () => {
  it('deduplicates targets and separates IPFS and external media', () => {
    const result = mediaTargetsFromManifest(
      [
        { kind: 'drop_media_url', url: `${CDN}/drops/${UUID}/a.png` },
        { kind: 'drop_media_url', url: `${CDN}/drops/${UUID}/a.png?x=1` },
        { kind: 'drop_media_url', url: 'https://example.com/x.png' },
        {
          kind: 'upload_object',
          bucket: null,
          key: `drops/${UUID}/a.png`,
          role: 'public'
        },
        {
          kind: 'upload_object',
          bucket: 'ingest',
          key: 'in/1',
          role: 'ingest'
        },
        {
          kind: 'attachment_object',
          attachmentId: 'a1',
          bucket: 'att',
          key: 'o/1.pdf'
        },
        {
          kind: 'attachment_object',
          attachmentId: 'a2',
          bucket: null,
          key: 'o/2.pdf'
        },
        { kind: 'attachment_ipfs', attachmentId: 'a1', cid: 'bafy2' },
        { kind: 'attachment_ipfs', attachmentId: 'a1', cid: 'bafy2' }
      ],
      { publicBucket: 'img' }
    );
    expect(result.targets.map((t) => `${t.bucket}/${t.key}`)).toEqual([
      'att/o/1.pdf',
      `img/drops/${UUID}/`,
      'ingest/in/1'
    ]);
    expect(result.ipfsCids).toEqual(['bafy2']);
    expect(result.externalUrls).toEqual(['https://example.com/x.png']);
  });
});

function memoryStore(objects: Record<string, LegacyDmObjectVersion[]>) {
  const deleted: string[] = [];
  const store: LegacyDmObjectStore = {
    listVersions: async (bucket, prefix) =>
      Object.entries(objects)
        .filter(([path]) => path.startsWith(`${bucket}/${prefix}`))
        .flatMap(([, versions]) => versions),
    deleteVersions: async (bucket, versions) => {
      deleted.push(...versions.map((v) => `${bucket}/${v.key}@${v.versionId}`));
      return versions.length;
    }
  };
  return { store, deleted };
}

describe('deleteLegacyDmMedia', () => {
  const objects = {
    [`img/drops/${UUID}/a.png`]: [
      { key: `drops/${UUID}/a.png`, versionId: 'v1', size: 10 },
      { key: `drops/${UUID}/a.png`, versionId: 'v0', size: 9 }
    ],
    [`img/drops/${UUID}/300x300/a.png`]: [
      { key: `drops/${UUID}/300x300/a.png`, versionId: 'v1', size: 3 }
    ],
    'img/waves/author_p1/keep.png': [
      { key: 'waves/author_p1/keep.png', versionId: 'v1', size: 5 }
    ]
  };
  const targets = [targetForKey('img', `drops/${UUID}/a.png`, true)];

  it('lists without deleting in a dry run', async () => {
    const { store, deleted } = memoryStore(objects);
    const result = await deleteLegacyDmMedia({
      targets,
      store,
      isStillReferenced: async () => false,
      execute: false
    });
    expect(result.versions).toBe(3);
    expect(result.bytes).toBe(22);
    expect(result.deletedVersions).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('deletes every version and returns paths to invalidate', async () => {
    const { store, deleted } = memoryStore(objects);
    const result = await deleteLegacyDmMedia({
      targets,
      store,
      isStillReferenced: async () => false,
      execute: true
    });
    expect(result.deletedVersions).toBe(3);
    expect(deleted).toHaveLength(3);
    expect(deleted.some((d) => d.includes('keep.png'))).toBe(false);
    expect(result.cdnPaths).toEqual([`/drops/${UUID}/*`]);
  });

  it('skips media a remaining row still references', async () => {
    const { store, deleted } = memoryStore(objects);
    const result = await deleteLegacyDmMedia({
      targets,
      store,
      isStillReferenced: async () => true,
      execute: true
    });
    expect(result.skippedStillReferenced).toBe(1);
    expect(deleted).toEqual([]);
  });
});
