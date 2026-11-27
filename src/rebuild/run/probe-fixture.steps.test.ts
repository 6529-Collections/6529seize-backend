import { createHash } from 'node:crypto';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import {
  ALL_WORLD_ACTORS,
  PROBE_WALLETS,
  SUBS_WIDE_LABELS,
  wavesPersonWallet,
  WorldActor,
  worldActorIdentity,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import * as steps from '@/rebuild/run/probe-fixture.steps';
import {
  checkWorldActors,
  checkWorldActorsStep,
  importedPrincipalId,
  principalByProfileId,
  probeProfileId,
  profileIdByWallet,
  seedProbeIdentities,
  writeWorldActorRows
} from '@/rebuild/run/probe-fixture.steps';
import { orderSeeds } from '@/rebuild/step-order';

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

  it("give a probe's fixed profile id, from 1, without reading", () => {
    expect(probeProfileId(1)).toBe('00000000-0000-4000-8000-000000000101');
    expect(probeProfileId(2)).toBe('00000000-0000-4000-8000-000000000102');
    expect(oneOrNull).not.toHaveBeenCalled();
    expect(() => probeProfileId(0)).toThrow('no probe wallet 0');
    expect(() => probeProfileId(3)).toThrow('no probe wallet 3');
    expect(() => probeProfileId(1.5)).toThrow('no probe wallet 1.5');
  });
});

describe('identity.actors-check', () => {
  /** Answers the lookups as a world holding `held` (wallet -> profile). */
  const world = (
    held: Record<string, string>,
    principals: Record<string, string | null> = {}
  ) =>
    oneOrNull.mockImplementation(
      async (sql: string, params: Record<string, string>) => {
        if (sql.includes('address_consolidation_keys')) {
          const id = held[params.wallet];
          return id ? { profile_id: id } : null;
        }
        const principal =
          params.profileId in principals
            ? principals[params.profileId]
            : importedPrincipalId(params.profileId);
        return principal === null ? null : { principal_id: principal };
      }
    );
  const everyone = (except: WorldActor[] = []) =>
    Object.fromEntries(
      ALL_WORLD_ACTORS.filter((actor) => !except.includes(actor)).flatMap(
        (actor) => {
          const { profileId, wallets } = worldActorIdentity(actor);
          return wallets.map((wallet) => [wallet, profileId]);
        }
      )
    );

  it("passes a world that holds every actor under the world's ids", async () => {
    world(everyone());
    await expect(checkWorldActors()).resolves.toEqual([]);
  });

  it('notes an actor the world lacks, unless probeProfileId names it', async () => {
    world(everyone(['dm-e2ee-a', 'records-service']));
    await expect(checkWorldActors()).resolves.toEqual([
      'records-service is not in this world; a seed that reads it by wallet fails there',
      'dm-e2ee-a is not in this world; a seed that reads it by wallet fails there'
    ]);
    world(everyone(['probe-2']));
    await expect(checkWorldActors()).rejects.toThrow(
      `probe-2: no identity holds wallet ${PROBE_WALLETS[1]}, but probeProfileId gives the world's id 00000000-0000-4000-8000-000000000102 for it`
    );
  });

  it('fails on another id under any wallet, or another principal', async () => {
    world({ ...everyone(), [PROBE_WALLETS[0]]: 'p-other' });
    await expect(checkWorldActors()).rejects.toThrow(
      `probe-1: wallet ${PROBE_WALLETS[0]} is held by profile p-other, not the world's 00000000-0000-4000-8000-000000000101`
    );
    // One of subs-wide's 15 wallets missing is a difference, not an absence.
    const last = worldActorWallet(SUBS_WIDE_LABELS[14]);
    const partial = everyone();
    delete partial[last];
    world(partial);
    await expect(checkWorldActors()).rejects.toThrow(
      `subs-wide: wallet ${last} is held by no profile, not the world's 00000000-0000-4000-8000-0000000001d0`
    );
    const liveOwner = '00000000-0000-4000-8000-0000000000b1';
    world(everyone(), { [liveOwner]: '0x01' });
    await expect(checkWorldActors()).rejects.toThrow(
      `live-owner: profile ${liveOwner}'s principal is 0x01, not the chain's ${importedPrincipalId(liveOwner)}`
    );
    world(everyone(), { [liveOwner]: null });
    await expect(checkWorldActors()).rejects.toThrow(
      `live-owner: profile ${liveOwner}'s principal is missing, not the chain's ${importedPrincipalId(liveOwner)}`
    );
  });

  it("writes the notes into the step's log", async () => {
    world(everyone(['dm-e2ee-c']));
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await checkWorldActorsStep();
      expect(write.mock.calls).toEqual([
        [
          'dm-e2ee-c is not in this world; a seed that reads it by wallet fails there\n'
        ]
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('runs right after identity.probe-profiles, before every other seed', () => {
    const order = orderSeeds(AREA_MANIFESTS.flatMap((m) => m.seeds)).order;
    expect(order.slice(0, 2).map((s) => s.id)).toEqual([
      'identity.probe-profiles',
      'identity.actors-check'
    ]);
    const check = order[1];
    expect(check).toMatchObject({
      run: { module: 'src/rebuild/run/probe-fixture.steps' },
      writes: [],
      after: ['identity.probe-profiles']
    });
    // The runner calls the export the manifest names: the check's step.
    const exportName = 'exportName' in check.run ? check.run.exportName : '';
    expect((steps as Record<string, unknown>)[exportName]).toBe(
      checkWorldActorsStep
    );
    expect([...(check.reads ?? [])].sort()).toEqual([
      'address_consolidation_keys',
      'identities',
      'identity_chain_principals'
    ]);
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
