import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { RebuildContext } from '@/rebuild/manifest.types';
import {
  fetchPlaceholdersFile,
  filesSourceUrl,
  PlaceholderRestoreRefused,
  PlaceholdersFileRefused,
  readPlaceholdersFile,
  restoredIdentityOf,
  restoreUntakenPlaceholders,
  writePlaceholderList
} from './placeholder-restore';
import {
  PLACEHOLDERS_FORMAT,
  PlaceholderAtFreezeLine
} from './placeholders-at-freeze.format';
import { consolidationKeyOf } from './identity-plan';

/** A placeholders file the tests fetch: the fixture, or the freeze's. */
const FIXTURE = { sha256: 'ab'.repeat(32), fixture: true };
const FREEZE = { sha256: 'ab'.repeat(32), fixture: false };
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function line(
  profileId: string,
  w: string,
  identity: Partial<PlaceholderAtFreezeLine['identity']> | null = {}
): PlaceholderAtFreezeLine {
  const handle = `id-${w.toLowerCase()}`;
  return {
    profile_id: profileId,
    wallet: w,
    handle,
    normalised_handle: handle,
    created_at_ms: 1_700_000_000_000,
    created_by_wallet: w,
    updated_at_ms: null,
    updated_by_wallet: null,
    pfp_url: null,
    banner_1: null,
    banner_2: null,
    website: null,
    classification: 'PSEUDONYM',
    sub_classification: null,
    identity:
      identity === null
        ? null
        : {
            consolidation_key: w.toLowerCase(),
            primary_address: w.toLowerCase(),
            handle,
            normalised_handle: handle,
            pfp: null,
            banner1: null,
            banner2: null,
            classification: 'PSEUDONYM',
            sub_classification: null,
            rep: 0,
            cic: 0,
            wallets: [w.toLowerCase()],
            ...identity
          }
  };
}

const HEADER = {
  format: PLACEHOLDERS_FORMAT,
  freeze_ms: 1_764_000_000_000,
  tdh_block: 7,
  exporter_revision: 'test'
};

/** A file of these lines (raw JSON values), and its SHA-256. */
function fileOf(
  lines: unknown[],
  header: Record<string, unknown> = { ...HEADER, count: lines.length }
): { bytes: Buffer; sha: string } {
  const text = [header, ...lines]
    .map((it) => `${JSON.stringify(it)}\n`)
    .join('');
  const bytes = gzipSync(Buffer.from(text, 'utf8'));
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

async function readAll(file: { bytes: Buffer; sha: string }, size = 2) {
  const batches: PlaceholderAtFreezeLine[][] = [];
  const header = await readPlaceholdersFile(
    file.bytes,
    file.sha,
    async (lines) => {
      batches.push(lines);
    },
    size
  );
  return { header, batches };
}

describe('the placeholders file', () => {
  it('is read a batch at a time, every line checked', async () => {
    const file = fileOf([
      line('a', wallet(1)),
      line('b', wallet(2), null),
      line('c', wallet(3))
    ]);
    const { header, batches } = await readAll(file, 2);
    expect(header).toEqual({ ...HEADER, count: 3 });
    expect(batches.map((it) => it.map((l) => l.profile_id))).toEqual([
      ['a', 'b'],
      ['c']
    ]);
    expect(batches[0][1].identity).toBeNull();
  });

  const refusals: [string, () => { bytes: Buffer; sha: string }, RegExp][] = [
    [
      'another format',
      () => fileOf([], { ...HEADER, format: 'other', count: 0 }),
      /not a 6529.placeholders-at-freeze.v1 header/
    ],
    [
      'a count that differs',
      () => fileOf([line('a', wallet(1))], { ...HEADER, count: 2 }),
      /counts 2 placeholders; the file has 1/
    ],
    [
      'a profile twice',
      () => fileOf([line('a', wallet(1)), line('a', wallet(2))]),
      /Line 3: profile a is not after/
    ],
    [
      'lines out of order',
      () => fileOf([line('b', wallet(1)), line('a', wallet(2))]),
      /Line 3: profile a is not after/
    ],
    [
      'a wallet twice',
      () =>
        fileOf([
          line('a', wallet(1)),
          line('b', wallet(1).toUpperCase().replace('0X', '0x'))
        ]),
      /wallet .* again/
    ],
    [
      'a profile that is no placeholder',
      () => fileOf([{ ...line('a', wallet(1)), normalised_handle: 'someone' }]),
      /Line 2: someone is not the placeholder handle/
    ],
    [
      'a field missing',
      () => {
        const { created_at_ms: _gone, ...rest } = line('a', wallet(1));
        return fileOf([rest]);
      },
      /Line 2: created_at_ms is not an integer/
    ],
    [
      'an identity without wallets',
      () => fileOf([line('a', wallet(1), { wallets: [] })]),
      /identity: wallets is not a list of wallets/
    ],
    [
      'a line that is not JSON',
      () => {
        const text = `${JSON.stringify({ ...HEADER, count: 1 })}\nnot json\n`;
        const bytes = gzipSync(Buffer.from(text));
        return {
          bytes,
          sha: createHash('sha256').update(bytes).digest('hex')
        };
      },
      /Line 2 is not JSON/
    ]
  ];

  it.each(refusals)('refuses %s', async (_what, make, message) => {
    const error = await readAll(make()).catch((e) => e);
    expect(error).toBeInstanceOf(PlaceholdersFileRefused);
    expect(error.message).toMatch(message);
  });

  it('refuses bytes of another SHA-256', async () => {
    const file = fileOf([line('a', wallet(1))]);
    await expect(
      readPlaceholdersFile(file.bytes, '00'.repeat(32), async () => undefined)
    ).rejects.toThrow(/SHA-256 is .*, not 0000/);
  });
});

describe('filesSourceUrl', () => {
  it("puts a file id under the source's path", () => {
    expect(filesSourceUrl('http://127.0.0.1:1/files/', 'b12ab_-Z')).toBe(
      'http://127.0.0.1:1/files/b12ab_-Z'
    );
  });

  it.each([
    ['a dot segment', 'http://127.0.0.1:1/files/..'],
    ['an encoded dot segment', 'http://127.0.0.1:1/files/%2e%2e'],
    ['a mixed-case encoded one', 'http://127.0.0.1:1/files/.%2E']
  ])(
    'puts it under the parsed path of a base with %s, not the base as written',
    (_what, base) => {
      const url = filesSourceUrl(base, 'abc');
      expect(url).toBe('http://127.0.0.1:1/abc');
      expect(new URL(url).pathname).toBe(
        `${new URL(base).pathname.replace(/\/+$/, '')}/abc`
      );
    }
  );

  it.each([
    ['another scheme', 'file:///files', 'abc'],
    ['a query', 'http://127.0.0.1:1/files?x=1', 'abc'],
    ['an empty query', 'http://127.0.0.1:1/files?', 'abc'],
    ['a fragment', 'http://127.0.0.1:1/files#x', 'abc'],
    ['a dot segment in the id', 'http://127.0.0.1:1/files', '..'],
    ['a slash in the id', 'http://127.0.0.1:1/files', 'a/b'],
    ['an encoded slash in the id', 'http://127.0.0.1:1/files', 'a%2Fb'],
    ['an empty id', 'http://127.0.0.1:1/files', '']
  ])('refuses %s', (_what, base, id) => {
    expect(() => filesSourceUrl(base, id)).toThrow();
  });
});

describe('fetchPlaceholdersFile', () => {
  const ctx = (files: string | null, final = false): RebuildContext => ({
    area: 'identity',
    stepId: 'identity.chain-mirror',
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files,
      repo: null
    },
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    final
  });
  const answer = (status: number) =>
    ({
      status,
      arrayBuffer: async () => Uint8Array.from(Buffer.from('x')).buffer
    }) as unknown as Response;

  it('reads the file from the files source by its SHA-256', async () => {
    const fetchImpl = jest.fn(async () => answer(200));
    const bytes = await fetchPlaceholdersFile(
      ctx('http://127.0.0.1:1/'),
      FIXTURE,
      fetchImpl as never
    );
    expect(bytes.toString()).toBe('x');
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:1/${FIXTURE.sha256}`
    );
  });

  it('refuses the fixture on a final run', async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchPlaceholdersFile(
        ctx('http://127.0.0.1:1', true),
        FIXTURE,
        fetchImpl as never
      )
    ).rejects.toThrow(/fixture, not the freeze's/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      fetchPlaceholdersFile(
        ctx('http://127.0.0.1:1', true),
        FREEZE,
        (async () => answer(200)) as never
      )
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('needs the files source, and the file in it', async () => {
    await expect(fetchPlaceholdersFile(ctx(null), FIXTURE)).rejects.toThrow(
      /--source files=/
    );
    await expect(
      fetchPlaceholdersFile(ctx('http://127.0.0.1:1'), FIXTURE, (async () =>
        answer(404)) as never)
    ).rejects.toThrow(/has no placeholders file .* \(404\)/);
  });
});

describe('restoredIdentityOf', () => {
  const A = wallet(0xa);
  const B = wallet(0xb);
  const pair = line('p', A, {
    consolidation_key: consolidationKeyOf([A, B]),
    primary_address: B,
    wallets: [A, B],
    rep: 5
  });

  it('keeps a row none of whose wallets is bound as stored', () => {
    // As stored: the case 6529.io wrote, which the mirror leaves alone.
    const mixed = '0x00000000000000000000000000000000000000Aa';
    const stored = line('u', mixed, {
      consolidation_key: mixed,
      primary_address: mixed,
      wallets: [mixed]
    });
    expect(restoredIdentityOf(stored, new Set([B]))).toEqual({
      identity: stored.identity,
      wallets: [mixed],
      rekeyed: false
    });
    // Bound, compared lowercased.
    expect(
      restoredIdentityOf(stored, new Set([mixed.toLowerCase()]))
    ).toBeNull();
  });

  it('leaves no row when all its wallets are bound, or it had none', () => {
    expect(restoredIdentityOf(pair, new Set([A, B]))).toBeNull();
    expect(restoredIdentityOf(line('n', A, null), new Set())).toBeNull();
  });

  it('re-keys a row some of whose wallets are bound, as the mirror does', () => {
    expect(restoredIdentityOf(pair, new Set([A]))).toEqual({
      identity: {
        ...pair.identity,
        consolidation_key: consolidationKeyOf([B]),
        primary_address: B,
        wallets: [B]
      },
      wallets: [B],
      rekeyed: true
    });
    // The primary address bound: the first wallet left is primary.
    expect(restoredIdentityOf(pair, new Set([B]))?.identity).toMatchObject({
      consolidation_key: A,
      primary_address: A,
      rep: 5
    });
  });
});

describe('the placeholder writes', () => {
  const U = wallet(0xc);
  const T = wallet(0xd);
  const BOUND = wallet(0xe);

  it("lists every placeholder as the mirror's first run does", async () => {
    const execute = jest.fn();
    await writePlaceholderList(
      [line('P-1', U.toUpperCase().replace('0X', '0x'))],
      { execute } as never
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /^insert ignore into identity_chain_placeholders \(wallet, profile_id\) values \(:l0_0, :l0_1\)$/
      ),
      { l0_0: U, l0_1: 'P-1' }
    );
  });

  it('restores the untaken ones: profile, identity and wallets, TDH at 0', async () => {
    const inserts: { sql: string; params: Record<string, unknown> }[] = [];
    const db = {
      execute: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        if (sql.includes('from identity_chain_principals')) {
          return [{ profile_id: 'TAKEN' }];
        }
        if (sql.includes('from address_consolidation_keys')) {
          return [{ address: BOUND }];
        }
        if (sql.includes('from profiles')) return [];
        inserts.push({ sql, params });
        return [];
      }),
      executeNativeQueriesInTransaction: jest.fn(async (work) => work({}))
    };
    const file = fileOf([
      line('TAKEN', wallet(0xa)),
      line('u', U, { rep: 3, cic: 2 }),
      line('v', BOUND),
      line('w', T, null)
    ]);
    const counts = await restoreUntakenPlaceholders(
      file.bytes,
      file.sha,
      db as never
    );
    expect(counts).toEqual({
      taken: 1,
      profiles: 3,
      identities: 1,
      rekeyed: 0,
      withoutIdentity: 2
    });
    const [profiles, identities, keys] = inserts;
    expect(profiles.sql).toMatch(/^insert into profiles/);
    expect(Object.values(profiles.params)).toEqual(
      expect.arrayContaining(['u', 'v', 'w', `id-${U}`, 1_700_000_000_000])
    );
    expect(profiles.params).not.toHaveProperty('p0_0', 'TAKEN');
    expect(profiles.sql).toContain(
      "timestampadd(microsecond, :p0_4 * 1000, '1970-01-01 00:00:00')"
    );
    expect(identities.sql).toMatch(/^insert into identities/);
    // consolidation key, profile, primary, handles, tdh 0, rep, cic,
    // level_raw = rep (+ tdh 0), pictures, classification.
    expect(identities.sql).toContain(
      '(:i0_0, :i0_1, :i0_2, :i0_3, :i0_4, 0, :i0_5, :i0_6, :i0_7,'
    );
    expect(identities.params).toMatchObject({
      i0_0: U,
      i0_1: 'u',
      i0_5: 3,
      i0_6: 2,
      i0_7: 3
    });
    expect(keys.sql).toMatch(/^insert into address_consolidation_keys/);
    expect(keys.params).toEqual({ k0_0: U, k0_1: U });
  });

  it('refuses an untaken id that a profiles row already holds, writing nothing', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('from profiles')) {
        return [{ external_id: 'u', handle: 'someone_else' }];
      }
      return [];
    });
    const db = {
      execute,
      executeNativeQueriesInTransaction: jest.fn(async (work) => work({}))
    };
    const file = fileOf([line('u', U), line('v', BOUND)]);
    const refused = restoreUntakenPlaceholders(
      file.bytes,
      file.sha,
      db as never
    );
    await expect(refused).rejects.toThrow(/u \(handle someone_else\)/);
    await expect(refused).rejects.toBeInstanceOf(PlaceholderRestoreRefused);
    expect(db.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(
      execute.mock.calls.filter(([sql]) => /^\s*insert/i.test(sql))
    ).toEqual([]);
  });
});
