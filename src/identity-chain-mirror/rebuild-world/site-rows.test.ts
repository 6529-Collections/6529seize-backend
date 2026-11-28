import { identityMetricsSync } from '@/identity-metrics-sync';
import { dbSupplier } from '@/sql-executor';
import { consolidatedTdhRowOf } from './consolidated-tdh-row';
import { isIdentityOnChain } from '@/identity-freeze/identity-freeze';
import { beforeSwitchOn, writeWavesPeopleTdh } from './site-rows';
import { WAVES_PEOPLE_TDH } from './world-ids';

jest.mock('@/api/identities/identities.service', () => ({
  identitiesService: {}
}));
jest.mock('@/identities/identities.db', () => ({ identitiesDb: {} }));
jest.mock('@/identity', () => ({ identityConsolidationEffects: {} }));
jest.mock('@/identity-metrics-sync', () => ({
  identityMetricsSync: { syncScoped: jest.fn() }
}));
jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

/** A key per person; the last two hold two wallets. */
function keyOf(index: number): { key: string; wallets: string[] } {
  const first = wallet(0x500 + index * 2);
  if (index < 2) return { key: first, wallets: [first] };
  const second = wallet(0x501 + index * 2);
  return { key: `${first}-${second}`, wallets: [second, first] };
}

/**
 * The rows an insert into tdh_consolidation carries, read back from its
 * named parameters (v<row>_<column>) in the columns' order.
 */
function rowsOf(sql: string, params: Record<string, unknown>) {
  const columns = /\(([^)]*)\) values/.exec(sql)![1].split(', ');
  const rows: Record<string, unknown>[] = [];
  for (const [name, value] of Object.entries(params)) {
    const [row, column] = name.slice(1).split('_').map(Number);
    rows[row] = { ...rows[row], [columns[column]]: value };
  }
  return rows;
}

function fakeDb(present: number) {
  const inserted: Record<string, unknown>[] = [];
  const execute = jest.fn(
    async (sql: string, params?: Record<string, unknown>) => {
      if (sql.startsWith('insert into tdh_consolidation')) {
        inserted.push(...rowsOf(sql, params!));
        return [];
      }
      if (sql.includes('from identities')) {
        return WAVES_PEOPLE_TDH.slice(0, present).map((it, i) => ({
          profile_id: it.profileId,
          consolidation_key: keyOf(i).key
        }));
      }
      return WAVES_PEOPLE_TDH.flatMap((_, i) =>
        keyOf(i).wallets.map((address) => ({
          address,
          consolidation_key: keyOf(i).key
        }))
      );
    }
  );
  const db = { execute };
  (dbSupplier as jest.Mock).mockReturnValue(db);
  return { db, inserted };
}

describe('writeWavesPeopleTdh', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes nothing when the recording holds none of them', async () => {
    const { inserted } = fakeDb(0);
    expect(await writeWavesPeopleTdh()).toBe(0);
    expect(inserted).toEqual([]);
    expect(identityMetricsSync.syncScoped).not.toHaveBeenCalled();
  });

  it('refuses a recording holding only some of them', async () => {
    fakeDb(3);
    await expect(writeWavesPeopleTdh()).rejects.toThrow(
      /3 identities rows for the waves world's 4 people with TDH, missing 00000000-0000-4000-8000-0000000001c7/
    );
    expect(identityMetricsSync.syncScoped).not.toHaveBeenCalled();
  });

  it("writes each one's TDH row on its key and wallets, then syncs those keys", async () => {
    const { inserted } = fakeDb(4);
    (identityMetricsSync.syncScoped as jest.Mock).mockResolvedValue({
      complete: true
    });
    expect(await writeWavesPeopleTdh()).toBe(4);
    const keys = WAVES_PEOPLE_TDH.map((_, i) => keyOf(i).key);
    // As the insert stores them: lists and objects as JSON, times as UTC.
    const stored = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          v instanceof Date
            ? v.toISOString().slice(0, 19).replace('T', ' ')
            : v !== null && typeof v === 'object'
              ? JSON.stringify(v)
              : v
        ])
      );
    expect(inserted).toEqual(
      WAVES_PEOPLE_TDH.map((it, i) =>
        stored(
          consolidatedTdhRowOf(
            keys[i],
            [...keyOf(i).wallets].sort((a, b) => (a < b ? -1 : Number(a > b))),
            it.tdh
          ) as unknown as Record<string, unknown>
        )
      )
    );
    expect(identityMetricsSync.syncScoped).toHaveBeenCalledWith({
      consolidationKeys: keys,
      profileIds: []
    });
  });

  it('fails when the sync does not finish', async () => {
    fakeDb(4);
    (identityMetricsSync.syncScoped as jest.Mock).mockResolvedValue({
      complete: false
    });
    await expect(writeWavesPeopleTdh()).rejects.toThrow(/did not finish/);
  });
});

describe('consolidatedTdhRowOf', () => {
  it("puts a two-wallet key's wallets on its row", () => {
    const { key, wallets } = keyOf(2);
    expect(consolidatedTdhRowOf(key, wallets, 7)).toMatchObject({
      consolidation_key: key,
      wallets,
      tdh: 7,
      boosted_tdh: 7
    });
  });
});

describe('beforeSwitchOn', () => {
  const NAMES = ['FEATURE_IDENTITY_ON_CHAIN', 'IDENTITY_SWITCH_ON_AT'];
  const saved = NAMES.map((name) => [name, process.env[name]] as const);
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs as before switch-on when the run sets a past switch-on time', async () => {
    process.env.FEATURE_IDENTITY_ON_CHAIN = 'false';
    process.env.IDENTITY_SWITCH_ON_AT = '2026-11-25T00:00:00Z';
    expect(isIdentityOnChain()).toBe(true);
    let inside: boolean | undefined;
    await beforeSwitchOn(async () => {
      inside = isIdentityOnChain();
    });
    expect(inside).toBe(false);
    expect(isIdentityOnChain()).toBe(true);
    expect(process.env.FEATURE_IDENTITY_ON_CHAIN).toBe('false');
    expect(process.env.IDENTITY_SWITCH_ON_AT).toBe('2026-11-25T00:00:00Z');
  });

  it('runs as before switch-on when the run turns the flag on', async () => {
    process.env.FEATURE_IDENTITY_ON_CHAIN = 'true';
    delete process.env.IDENTITY_SWITCH_ON_AT;
    let inside: boolean | undefined;
    await beforeSwitchOn(async () => {
      inside = isIdentityOnChain();
    });
    expect(inside).toBe(false);
    expect(process.env.FEATURE_IDENTITY_ON_CHAIN).toBe('true');
    expect('IDENTITY_SWITCH_ON_AT' in process.env).toBe(false);
  });

  it('puts both back after a throw', async () => {
    process.env.FEATURE_IDENTITY_ON_CHAIN = 'false';
    process.env.IDENTITY_SWITCH_ON_AT = '2026-11-25T00:00:00Z';
    await expect(
      beforeSwitchOn(async () => {
        throw new Error('the write failed');
      })
    ).rejects.toThrow('the write failed');
    expect(process.env.FEATURE_IDENTITY_ON_CHAIN).toBe('false');
    expect(process.env.IDENTITY_SWITCH_ON_AT).toBe('2026-11-25T00:00:00Z');
    expect(isIdentityOnChain()).toBe(true);
  });
});
