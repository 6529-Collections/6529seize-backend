import { createHash } from 'node:crypto';
import {
  PROBE_WALLETS,
  SUBS_WIDE_LABELS,
  wavesPersonWallet,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import {
  importedPrincipalId,
  principalByProfileId,
  probeProfileId,
  profileIdByWallet,
  seedProbeIdentities,
  writeWorldActorRows
} from '@/rebuild/run/probe-fixture.steps';

const execute = jest.fn();
const oneOrNull = jest.fn();
jest.mock('@/sql-executor', () => ({
  dbSupplier: () => ({ execute, oneOrNull })
}));

beforeEach(() => {
  execute.mockReset().mockResolvedValue([]);
  oneOrNull.mockReset().mockResolvedValue(null);
});

/** The table each statement writes, in order. */
const tables = () =>
  execute.mock.calls.map(
    ([sql]: [string]) => /insert ignore into (\w+)/.exec(sql)?.[1]
  );

describe('the lookups', () => {
  it('read a profile id by wallet, in lower case', async () => {
    oneOrNull.mockResolvedValue({ profile_id: 'p-1' });
    await expect(profileIdByWallet('0xABC')).resolves.toBe('p-1');
    expect(oneOrNull.mock.calls[0][0]).toContain('address_consolidation_keys');
    expect(oneOrNull.mock.calls[0][1]).toEqual({ wallet: '0xabc' });
  });

  it("name the wallet and its label when no identity's profile holds it", async () => {
    const wallet = worldActorWallet('records-service');
    await expect(profileIdByWallet(wallet)).rejects.toThrow(
      `No identity with a profile holds wallet ${wallet} (records-service)`
    );
    oneOrNull.mockResolvedValue({ profile_id: null });
    await expect(profileIdByWallet(PROBE_WALLETS[1])).rejects.toThrow(
      '(probe-2)'
    );
    await expect(
      profileIdByWallet(wavesPersonWallet('devnet_p4_b'))
    ).rejects.toThrow(
      '(devnet_p4_b). The waves people come only from a recording'
    );
    await expect(profileIdByWallet('0x' + '77'.repeat(20))).rejects.toThrow(
      /holds wallet 0x7{40}$/
    );
  });

  it('read a principal by profile id, and refuse a profile without one', async () => {
    await expect(principalByProfileId('p-1')).rejects.toThrow(
      'Profile p-1 has no chain principal'
    );
    oneOrNull.mockResolvedValue({ principal_id: '0x01' });
    await expect(principalByProfileId('p-1')).resolves.toBe('0x01');
  });

  it('read a probe profile by the probe wallet, from 1', async () => {
    oneOrNull.mockResolvedValue({ profile_id: 'p-2' });
    await expect(probeProfileId(2)).resolves.toBe('p-2');
    expect(oneOrNull.mock.calls[0][1]).toEqual({ wallet: PROBE_WALLETS[1] });
    await expect(probeProfileId(0)).rejects.toThrow('no probe wallet 0');
    await expect(probeProfileId(3)).rejects.toThrow('no probe wallet 3');
  });
});

describe("an imported profile's principal", () => {
  /**
   * The principals a gateway recording's identity world holds for four
   * imported identities (the probes, the pair and the site TDH identity):
   * the SHA-256 of JSON.stringify of their [profile id, principal] pairs.
   */
  const IMPORTED_PRINCIPALS_SHA256 =
    '159f2fa3d2407097e32b5f2b2190a7cf45aead13abd03cc7c3c99015a900f3a0';

  it("is the chain's holder id of its legacy id", () => {
    const ids = ['101', '102', '103', '10b'].map(
      (n) => `00000000-0000-4000-8000-000000000${n}`
    );
    const pairs = ids.map((id) => [id, importedPrincipalId(id)]);
    expect(
      createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
    ).toBe(IMPORTED_PRINCIPALS_SHA256);
    expect(() => importedPrincipalId('rebuild-probe-1')).toThrow(
      'is not a UUID'
    );
  });
});

describe("the world's rows", () => {
  /**
   * The read-back answers with the actor last written: its profile, the
   * profile holding each wallet, and its principal. A test changes one.
   */
  let written: string | null = null;
  let answers: {
    profile?: unknown;
    holder?: unknown;
    principal?: unknown;
    principalHolder?: unknown;
  } = {};
  beforeEach(() => {
    written = null;
    answers = {};
    execute.mockImplementation(
      async (sql: string, params: { profileId?: string }) => {
        if (sql.includes('into profiles')) written = params.profileId ?? null;
        return [];
      }
    );
    oneOrNull.mockImplementation(
      async (sql: string, params: { want?: string }) => {
        if (sql.includes('from profiles')) {
          return 'profile' in answers
            ? answers.profile
            : { external_id: written };
        }
        if (sql.includes('identity_chain_principals') && params.want) {
          // Who holds the chain's principal, asked when the profile has none.
          return answers.principalHolder ?? null;
        }
        if (sql.includes('identity_chain_principals')) {
          return 'principal' in answers
            ? answers.principal
            : { principal_id: written && importedPrincipalId(written) };
        }
        return 'holder' in answers ? answers.holder : { profile_id: written };
      }
    );
  });

  it('write a profile, an identity and its wallets, and a principal when asked', async () => {
    await writeWorldActorRows(['records-service']);
    expect(tables()).toEqual([
      'profiles',
      'identities',
      'address_consolidation_keys'
    ]);
    const wallet = worldActorWallet('records-service');
    expect(execute.mock.calls[1][1]).toMatchObject({
      key: wallet,
      primary: wallet,
      profileId: '00000000-0000-4000-8000-0000000001a1',
      handle: 'rebuild_records',
      normalised: 'rebuild_records'
    });
    // Read back: the profile by its handle, then each wallet.
    expect(oneOrNull.mock.calls.map(([, params]) => params)).toEqual([
      { normalised: 'rebuild_records' },
      { wallet }
    ]);
    execute.mockClear();
    oneOrNull.mockClear();
    await writeWorldActorRows(['probe-1'], { principals: true });
    expect(tables()).toEqual([
      'profiles',
      'identities',
      'address_consolidation_keys',
      'identity_chain_principals'
    ]);
    expect(execute.mock.calls[3][1]).toMatchObject({
      principal: importedPrincipalId('00000000-0000-4000-8000-000000000101'),
      profileId: '00000000-0000-4000-8000-000000000101'
    });
    // The principal read back too.
    expect(oneOrNull.mock.calls.map(([, params]) => params)).toEqual([
      { normalised: 'rebuild_probe_1' },
      { wallet: PROBE_WALLETS[0] },
      { profileId: '00000000-0000-4000-8000-000000000101' }
    ]);
  });

  it('write subs-wide as one identity holding 15 wallets, the lowest its primary', async () => {
    await writeWorldActorRows(['subs-wide']);
    const sorted = SUBS_WIDE_LABELS.map((label) =>
      worldActorWallet(label)
    ).sort((a, b) => (a < b ? -1 : Number(a > b)));
    const key = sorted.join('-');
    expect(execute.mock.calls[1][1]).toMatchObject({ key, primary: sorted[0] });
    expect(
      execute.mock.calls
        .filter(([sql]: [string]) => sql.includes('address_consolidation_keys'))
        .map(([, params]) => params)
    ).toEqual(sorted.map((wallet) => ({ wallet, key })));
  });

  it("fail when another seed's row stands where the actor's should", async () => {
    const world = '00000000-0000-4000-8000-000000000101';
    answers = { profile: { external_id: 'rebuild-probe-1' } };
    await expect(writeWorldActorRows(['probe-1'])).rejects.toThrow(
      `probe-1: handle rebuild_probe_1 belongs to profile rebuild-probe-1, not the world's ${world}; another seed wrote it`
    );
    answers = { profile: null };
    await expect(writeWorldActorRows(['probe-1'])).rejects.toThrow(
      'handle rebuild_probe_1 belongs to no profile'
    );
    answers = { holder: { profile_id: 'rebuild-probe-1' } };
    await expect(writeWorldActorRows(['probe-1'])).rejects.toThrow(
      `probe-1: wallet ${PROBE_WALLETS[0]} is held by profile rebuild-probe-1`
    );
    answers = { holder: null };
    await expect(writeWorldActorRows(['dm-e2ee-c'])).rejects.toThrow(
      'is held by no profile'
    );
    const chain = importedPrincipalId(world);
    answers = { principal: { principal_id: '0x01' } };
    await expect(
      writeWorldActorRows(['probe-1'], { principals: true })
    ).rejects.toThrow(
      `probe-1: profile ${world}'s principal is 0x01, not the chain's ${chain}; another seed wrote it`
    );
    // No principal row for the profile: the chain's principal is another's,
    // or nobody's.
    answers = {
      principal: null,
      principalHolder: { profile_id: 'rebuild-probe-1' }
    };
    await expect(
      writeWorldActorRows(['probe-1'], { principals: true })
    ).rejects.toThrow(
      `probe-1: the chain's principal ${chain} is profile rebuild-probe-1's, not ${world}'s`
    );
    answers = { principal: null };
    await expect(
      writeWorldActorRows(['probe-1'], { principals: true })
    ).rejects.toThrow(`probe-1: profile ${world} has no principal`);
    // Without principals, a principal row isn't read.
    await expect(writeWorldActorRows(['probe-1'])).resolves.toBeUndefined();
  });

  it('let a lost connection through as it is', async () => {
    // The handle reads back; the wallet's read loses the connection.
    const asWritten = oneOrNull.getMockImplementation()!;
    oneOrNull.mockImplementation(async (sql: string, params: unknown) => {
      if (sql.includes('address_consolidation_keys')) {
        throw new Error('connection lost');
      }
      return asWritten(sql, params);
    });
    await expect(writeWorldActorRows(['probe-2'])).rejects.toThrow(
      'connection lost'
    );
  });

  it('seed every actor with its principal on the fallback world', async () => {
    await seedProbeIdentities();
    expect(
      tables().filter((table) => table === 'identity_chain_principals')
    ).toHaveLength(8);
    expect(
      tables().filter((table) => table === 'address_consolidation_keys')
    ).toHaveLength(7 + 15);
  });
});
