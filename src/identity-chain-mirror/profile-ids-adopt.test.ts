import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { consolidationKeyOf, principalProfileId } from './identity-plan';
import { ProfileIds } from './profile-ids';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const A = W(0xa1);
const B = W(0xb2);
const C = W(0xc3);
const P = '0x' + 'ab'.repeat(32);
const ROW_ID = '00000000-0000-4000-8000-00000000ad01';
const LEGACY = '00000000-0000-4000-8000-00000000ad02';

/** A handle-less row as the DB read gives it: key and profile id. */
interface Row {
  readonly consolidation_key: string;
  readonly profile_id: string;
}

/**
 * The mirror's DB as ProfileIds reads it: a handle-less row read answers
 * the rows given whose key is the identity's or holds one of its wallets.
 */
function fakeDb(rows: Row[]) {
  const mapping = new Map<string, { profile: string; origin: string }>();
  const db = {
    mapping,
    executeNativeQueriesInTransaction: async <T>(fn: (conn: unknown) => T) =>
      fn({}),
    profileIdOfPrincipal: async (p: string) => mapping.get(p)?.profile ?? null,
    insertMapping: async (p: string, profile: string, origin: string) => {
      mapping.set(p, { profile, origin });
    },
    unmappedPlaceholderProfile: async () => null,
    handlelessRowsOf: jest.fn(async (wallets: readonly string[], key: string) =>
      rows.filter(
        (row) =>
          row.consolidation_key === key ||
          row.consolidation_key
            .split('-')
            .some((w) => wallets.map((it) => it.toLowerCase()).includes(w))
      )
    ),
    firstBindingOf: async () => null,
    founderWaitSince: async () => 0,
    founderWaitDone: async () => undefined,
    founderDecisionOf: async () => null,
    founderDecided: async () => undefined
  };
  return db;
}

function identity(wallets: string[], extra: Partial<ChainIdentity> = {}) {
  return {
    principalId: P,
    kind: 'person',
    status: 'active',
    createdHeight: 100,
    handle: null,
    anchor: wallets[0],
    primary: wallets[0],
    primarySource: 'anchor',
    wallets,
    profile: null,
    rep: { total: '0', raters: 0 },
    nic: { total: '0', raters: 0 },
    level: null,
    mergedInto: null,
    // Imported without a legacy id (the export wrote none), or made on
    // the chain after the import: no legacy id either way.
    legacyId: null,
    founder: wallets[0],
    ...extra
  } as ChainIdentity;
}

function idsWith(rows: Row[]) {
  const db = fakeDb(rows);
  const ids = new ProfileIds({} as never, db as never, () => 1_000);
  // Made after the import: its missing legacy id is final, no gateway read.
  ids.setImportHeights(10, 50);
  return { ids, db };
}

describe("ProfileIds: a handle-less row's id, kept", () => {
  it('takes the id of the handle-less row under the identity’s own key, several wallets', async () => {
    const { ids, db } = idsWith([
      { consolidation_key: consolidationKeyOf([A, B]), profile_id: ROW_ID }
    ]);
    expect(await ids.profileIdOf(identity([B, A]))).toBe(ROW_ID);
    expect(db.mapping.get(P)).toEqual({ profile: ROW_ID, origin: 'ADOPTED' });
    expect(ids.takeNotAdopted()).toEqual([]);
  });

  it('takes it for one wallet, as for a row a group listing made', async () => {
    const { ids, db } = idsWith([{ consolidation_key: A, profile_id: ROW_ID }]);
    expect(await ids.profileIdOf(identity([A]))).toBe(ROW_ID);
    expect(db.mapping.get(P)?.origin).toBe('ADOPTED');
  });

  it('does not take it when the identity holds more wallets than the row, and notes the key', async () => {
    const key = consolidationKeyOf([A, B]);
    const { ids, db } = idsWith([
      { consolidation_key: key, profile_id: ROW_ID }
    ]);
    expect(await ids.profileIdOf(identity([A, B, C]))).toBe(
      principalProfileId(P)
    );
    expect(db.mapping.get(P)?.origin).toBe('NEW');
    expect(ids.takeNotAdopted()).toEqual([key]);
    // Taken once: the next call starts empty.
    expect(ids.takeNotAdopted()).toEqual([]);
  });

  it('does not take it when the identity holds fewer wallets than the row', async () => {
    const key = consolidationKeyOf([A, B]);
    const { ids } = idsWith([{ consolidation_key: key, profile_id: ROW_ID }]);
    expect(await ids.profileIdOf(identity([A]))).toBe(principalProfileId(P));
    expect(ids.takeNotAdopted()).toEqual([key]);
  });

  it('keeps an imported identity’s legacy id before any handle-less row', async () => {
    const { ids, db } = idsWith([{ consolidation_key: A, profile_id: ROW_ID }]);
    expect(await ids.profileIdOf(identity([A], { legacyId: LEGACY }))).toBe(
      LEGACY
    );
    expect(db.mapping.get(P)?.origin).toBe('LEGACY');
    expect(db.handlelessRowsOf).not.toHaveBeenCalled();
  });

  it('gives the derived id when no handle-less row holds its wallets, noting nothing', async () => {
    const { ids } = idsWith([]);
    expect(await ids.profileIdOf(identity([A, B]))).toBe(principalProfileId(P));
    expect(ids.takeNotAdopted()).toEqual([]);
  });

  it("lists the row's id among the candidates of an identity still waiting, without a note", async () => {
    const key = consolidationKeyOf([A, B]);
    const { ids } = idsWith([{ consolidation_key: key, profile_id: ROW_ID }]);
    expect(await ids.candidateIds(identity([A, B]))).toContain(ROW_ID);
    expect(await ids.candidateIds(identity([A, B, C]))).not.toContain(ROW_ID);
    expect(ids.takeNotAdopted()).toEqual([]);
  });
});
