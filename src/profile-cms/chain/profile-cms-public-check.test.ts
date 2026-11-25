import { cmsCidFromHash } from '@/profile-cms/chain/profile-cms-cid';
import {
  checkExportAgainstPublicApi,
  httpPublicPrimaryLookup,
  PUBLIC_API_MIN_INTERVAL_MS,
  PublicPrimaryCheckEntry
} from '@/profile-cms/chain/profile-cms-public-check';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const PUBLICATION = cmsCidFromHash(`sha256:${'c'.repeat(64)}`);

function entry(
  profileId: string,
  handle: string | null,
  packageHash: string | null,
  primaryHandle: string | null = handle,
  refusedPrimaryHash: string | null = null
): PublicPrimaryCheckEntry {
  return {
    profile_id: profileId,
    handle,
    primaryHandle,
    refusedPrimaryHash,
    cms: packageHash
      ? {
          primary: {
            publication: PUBLICATION,
            package: cmsCidFromHash(packageHash)
          },
          archive: null
        }
      : null
  };
}

describe('checkExportAgainstPublicApi', () => {
  it('lists a primary the export refused at T apart from the mismatches', async () => {
    const result = await checkExportAgainstPublicApi(
      [
        entry('p1', 'one', null, 'one', HASH_A),
        entry('p2', 'two', null, 'two', HASH_A)
      ],
      async (handle) =>
        handle === 'one'
          ? { status: 'found', package_hash: HASH_A }
          : { status: 'found', package_hash: HASH_B },
      async () => undefined
    );
    expect(result.refused).toEqual([
      {
        profile_id: 'p1',
        handle: 'one',
        exported: null,
        public: HASH_A,
        detail: 'refused_at_t'
      }
    ]);
    // Serving another package than the refused one is still a mismatch.
    expect(result.mismatches).toEqual([
      { profile_id: 'p2', handle: 'two', exported: null, public: HASH_B }
    ]);
  });

  it('matches when the exported primary is the one the public API serves', async () => {
    const waits: number[] = [];
    const result = await checkExportAgainstPublicApi(
      [entry('p1', 'one', HASH_A), entry('p2', 'two', null)],
      async (handle) =>
        handle === 'one'
          ? { status: 'found', package_hash: HASH_A }
          : { status: 'none' },
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(result).toEqual({ checked: 2, mismatches: [], refused: [] });
    expect(waits).toEqual([PUBLIC_API_MIN_INTERVAL_MS]);
  });

  it('reports a different package, a missing one and an extra one', async () => {
    const served: Record<string, string | null> = {
      one: HASH_B,
      two: null,
      three: HASH_A
    };
    const result = await checkExportAgainstPublicApi(
      [
        entry('p1', 'one', HASH_A),
        entry('p2', 'two', HASH_A),
        entry('p3', 'three', null)
      ],
      async (handle) =>
        served[handle]
          ? { status: 'found', package_hash: served[handle] as string }
          : { status: 'none' },
      async () => undefined
    );
    expect(result.mismatches).toEqual([
      { profile_id: 'p1', handle: 'one', exported: HASH_A, public: HASH_B },
      { profile_id: 'p2', handle: 'two', exported: HASH_A, public: null },
      { profile_id: 'p3', handle: 'three', exported: null, public: HASH_A }
    ]);
  });

  it('expects no public site when the handle changed since publishing', async () => {
    const result = await checkExportAgainstPublicApi(
      [entry('p1', 'newname', HASH_A, 'oldname')],
      async () => ({ status: 'none' }),
      async () => undefined
    );
    expect(result.mismatches).toEqual([]);
  });

  it('reports lookup errors and exported sites without a handle', async () => {
    const result = await checkExportAgainstPublicApi(
      [entry('p1', 'one', HASH_A), entry('p2', null, HASH_A)],
      async () => ({ status: 'error', detail: 'http_503' }),
      async () => undefined
    );
    expect(result.mismatches).toEqual([
      {
        profile_id: 'p1',
        handle: 'one',
        exported: HASH_A,
        public: null,
        detail: 'http_503'
      },
      {
        profile_id: 'p2',
        handle: null,
        exported: HASH_A,
        public: null,
        detail: 'no_handle'
      }
    ]);
  });
});

describe('httpPublicPrimaryLookup', () => {
  it('asks the primary route and reads its package hash', async () => {
    const urls: string[] = [];
    const lookup = httpPublicPrimaryLookup(
      'https://api.example.test/api/',
      async (url) => {
        urls.push(url);
        return { status: 200, body: { package_hash: HASH_A } };
      }
    );
    expect(await lookup('one two')).toEqual({
      status: 'found',
      package_hash: HASH_A
    });
    expect(urls).toEqual([
      'https://api.example.test/api/profile-cms/one%20two/primary'
    ]);
  });

  it.each([
    [{ status: 404, body: null }, { status: 'none' }],
    [
      { status: 500, body: null },
      { status: 'error', detail: 'http_500' }
    ],
    [
      { status: 200, body: {} },
      { status: 'error', detail: 'http_200' }
    ]
  ])('maps %j', async (response, expected) => {
    const lookup = httpPublicPrimaryLookup(
      'https://api.example.test/api',
      async () => response
    );
    expect(await lookup('one')).toEqual(expected);
  });

  it('maps a network failure to an error', async () => {
    const lookup = httpPublicPrimaryLookup(
      'https://api.example.test/api',
      async () => {
        throw new Error('timeout');
      }
    );
    expect(await lookup('one')).toEqual({ status: 'error', detail: 'timeout' });
  });
});
