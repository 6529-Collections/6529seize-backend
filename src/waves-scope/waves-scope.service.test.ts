import { randomUUID } from 'node:crypto';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { formatNamedParameters } from '@/db/sql-named-parameters';
import { Logger } from '@/logging';
import {
  CHAIN_INDEX_STATE_TABLE_NAME,
  CHAIN_NETWORK_ID_ENV,
  CHAIN_WAVES_TABLE_NAME
} from '@/waves-chain-index/waves-chain-mapping';
import {
  MOVED_ON_CHAIN_COLUMN,
  RECORDS_WAVE_ID_ENV,
  SCOPE_SQL_PARAMS,
  STAY_REASONS
} from '@/waves-scope/waves-scope';
import {
  CHAIN_NOT_READY_CACHE_MS,
  CHAIN_READY_CACHE_MS,
  CHAIN_TABLES_MISSING_MESSAGE,
  NETWORK_UNSET_MESSAGE,
  RECORDS_NONE_MESSAGE,
  RECORDS_UNSET_MESSAGE,
  SCOPE_GROUP_IDS_PER_STATEMENT,
  SCOPE_WAVE_IDS_PER_STATEMENT,
  scopeSqlParamValues,
  WavesScopeService,
  wavesSettingsReporter
} from '@/waves-scope/waves-scope.service';

const NETWORK = '0x' + 'ee'.repeat(32);
const WAVES_SETTINGS = [
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_FROZEN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_ON_CHAIN'
];
const SETTINGS = [...WAVES_SETTINGS, RECORDS_WAVE_ID_ENV, CHAIN_NETWORK_ID_ENV];

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const name of SETTINGS) saved[name] = process.env[name];
});
beforeEach(() => {
  for (const name of SETTINGS) delete process.env[name];
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  for (const name of SETTINGS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function fakeLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('wavesSettingsReporter', () => {
  it('only warns about unset settings while no waves setting is configured', () => {
    const log = fakeLog();
    const report = wavesSettingsReporter(log);
    report({});
    report({});
    expect(log.warn.mock.calls).toEqual([
      [RECORDS_UNSET_MESSAGE],
      [NETWORK_UNSET_MESSAGE]
    ]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([
    ['WAVES_FREEZE_AT', '2026-11-27T00:00:00Z'],
    ['FEATURE_WAVES_FROZEN', 'true'],
    ['WAVES_SWITCH_ON_AT', '2026-11-28T00:00:00Z'],
    ['FEATURE_WAVES_ON_CHAIN', 'true']
  ])(
    'logs them as errors, once per cold start, once %s is set',
    (name, value) => {
      const log = fakeLog();
      const report = wavesSettingsReporter(log);
      report({ [name]: value });
      report({ [name]: value });
      expect(log.error.mock.calls).toEqual([
        [RECORDS_UNSET_MESSAGE],
        [NETWORK_UNSET_MESSAGE]
      ]);
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it('counts a flag that is not on as no setting', () => {
    const log = fakeLog();
    wavesSettingsReporter(log)({ FEATURE_WAVES_FROZEN: 'false' });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('logs none as information, and nothing for an id and a network', () => {
    const none = fakeLog();
    wavesSettingsReporter(none)({
      FEATURE_WAVES_FROZEN: 'true',
      [RECORDS_WAVE_ID_ENV]: 'None',
      [CHAIN_NETWORK_ID_ENV]: NETWORK
    });
    expect(none.info.mock.calls).toEqual([[RECORDS_NONE_MESSAGE]]);
    expect(none.error).not.toHaveBeenCalled();
    const set = fakeLog();
    wavesSettingsReporter(set)({
      FEATURE_WAVES_FROZEN: 'true',
      [RECORDS_WAVE_ID_ENV]: 'records',
      [CHAIN_NETWORK_ID_ENV]: NETWORK
    });
    expect([set.info, set.warn, set.error].map((it) => it.mock.calls)).toEqual([
      [],
      [],
      []
    ]);
  });

  it('names each setting in its line', () => {
    expect(RECORDS_UNSET_MESSAGE).toContain(
      '[SIGNED_RECORDS_WAVE_ID IS NOT SET]'
    );
    expect(NETWORK_UNSET_MESSAGE).toContain(
      '[WAVES_SETTLEMENT_NETWORK_ID IS NOT SET]'
    );
  });
});

describe('scopeSqlParamValues', () => {
  it('passes the records wave id in lower case, and null for none or unset', () => {
    process.env[RECORDS_WAVE_ID_ENV] = 'Records';
    expect(scopeSqlParamValues()[SCOPE_SQL_PARAMS.records]).toBe('records');
    process.env[RECORDS_WAVE_ID_ENV] = 'none';
    expect(scopeSqlParamValues()[SCOPE_SQL_PARAMS.records]).toBeNull();
    delete process.env[RECORDS_WAVE_ID_ENV];
    expect(scopeSqlParamValues()[SCOPE_SQL_PARAMS.records]).toBeNull();
  });
});

/** A database that answers the scope's statements, and records them. */
function fakeDb({
  tables = true,
  state = { last_full_at: 1, network: NETWORK } as Record<
    string,
    unknown
  > | null,
  usedIn = [] as string[]
} = {}) {
  const statements: { sql: string; params: Record<string, any> }[] = [];
  let current = state;
  const scopeRow = (id: string) => ({
    id,
    [MOVED_ON_CHAIN_COLUMN]: 0,
    ...Object.fromEntries(STAY_REASONS.map((reason) => [reason, 0]))
  });
  const db = {
    execute: jest.fn(async (sql: string, params: Record<string, any>) => {
      statements.push({ sql, params });
      if (sql.includes(`from ${CHAIN_INDEX_STATE_TABLE_NAME}`))
        return current ? [current] : [];
      return (params.waveIds ?? []).map(scopeRow);
    }),
    oneOrNull: jest.fn(async (sql: string, params: Record<string, any>) => {
      statements.push({ sql, params });
      if (sql.includes('information_schema.tables'))
        return { tables: tables ? 2 : 0 };
      return {
        used: (params.groupIds as string[]).some((id) => usedIn.includes(id))
          ? 1
          : 0
      };
    })
  };
  const of = (needle: string) =>
    statements.filter((it) => it.sql.includes(needle));
  const setState = (next: Record<string, unknown> | null) => {
    current = next;
  };
  return { db, statements, of, setState };
}

function service(
  db: ReturnType<typeof fakeDb>['db'],
  switchedOn: boolean,
  cacheMs: { readyCacheMs?: number; notReadyCacheMs?: number } = {
    readyCacheMs: 0,
    notReadyCacheMs: 0
  }
) {
  const log = fakeLog();
  return {
    log,
    scope: new WavesScopeService(
      () => db as any,
      () => switchedOn,
      {
        ...cacheMs,
        log
      }
    )
  };
}

const READS_THE_CHAIN = `from ${CHAIN_WAVES_TABLE_NAME}`;

describe('the chain index, after the switch-on', () => {
  beforeEach(() => {
    process.env.WAVES_SWITCH_ON_AT = '2026-11-28T00:00:00Z';
    process.env[RECORDS_WAVE_ID_ENV] = 'none';
  });

  it('reads which waves the chain holds once the index is ready on the expected network', async () => {
    process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
    const fake = fakeDb();
    const { scope, log } = service(fake.db, true);
    await scope.waveScopes(['a'], {});
    expect(fake.of(`where w.id in`)[0].sql).toContain(READS_THE_CHAIN);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('counts no read as ready while WAVES_SETTLEMENT_NETWORK_ID is unset, and says so once', async () => {
    const fake = fakeDb();
    const { scope, log } = service(fake.db, true);
    await scope.waveScopes(['a'], {});
    await scope.usedByMovingWave(['g'], {});
    await scope.waveScopes(['b'], {});
    // The rule decides: nothing reads the index or its mapping.
    expect(fake.of(CHAIN_INDEX_STATE_TABLE_NAME)).toEqual([]);
    expect(fake.of('information_schema')).toEqual([]);
    for (const statement of fake.statements)
      expect(statement.sql).not.toContain(READS_THE_CHAIN);
    expect(log.error.mock.calls).toEqual([[NETWORK_UNSET_MESSAGE]]);
  });

  it('reads missing index tables as not ready, without a failed statement, and says so once', async () => {
    process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
    const fake = fakeDb({ tables: false });
    const { scope, log } = service(fake.db, true);
    for (let i = 0; i < 3; i++) await scope.waveScopes(['a'], {});
    expect(fake.of(`from ${CHAIN_INDEX_STATE_TABLE_NAME}`)).toEqual([]);
    expect(fake.of(`where w.id in`)[0].sql).not.toContain(READS_THE_CHAIN);
    expect(log.error.mock.calls).toEqual([[CHAIN_TABLES_MISSING_MESSAGE]]);
  });

  it('reuses its reading of readiness for the cache time, per network', async () => {
    process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
    const fake = fakeDb();
    const { scope } = service(fake.db, true, {});
    await scope.waveScopes(['a'], {});
    await scope.usedByMovingWave(['g'], {});
    expect(fake.of('information_schema')).toHaveLength(1);
    expect(fake.of(`from ${CHAIN_INDEX_STATE_TABLE_NAME}`)).toHaveLength(1);
    // Another expected network is read again, and isn't ready.
    process.env[CHAIN_NETWORK_ID_ENV] = '0x' + 'ff'.repeat(32);
    await scope.waveScopes(['a'], {});
    expect(fake.of(`from ${CHAIN_INDEX_STATE_TABLE_NAME}`)).toHaveLength(2);
    expect(fake.of(`where w.id in`)[1].sql).not.toContain(READS_THE_CHAIN);
  });
});

describe('the readiness cache', () => {
  beforeEach(() => {
    process.env.WAVES_SWITCH_ON_AT = '2026-11-28T00:00:00Z';
    process.env[RECORDS_WAVE_ID_ENV] = 'none';
    process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
  });

  async function readsTheChain(
    scope: WavesScopeService,
    fake: ReturnType<typeof fakeDb>
  ) {
    await scope.waveScopes(['a'], {});
    const reads = fake.of('where w.id in');
    return reads[reads.length - 1].sql.includes(READS_THE_CHAIN);
  }

  it('sees an index reset after it read ready within CHAIN_READY_CACHE_MS', async () => {
    expect(CHAIN_READY_CACHE_MS).toBe(5_000);
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fake = fakeDb();
    const { scope } = service(fake.db, true, {});
    expect(await readsTheChain(scope, fake)).toBe(true);
    // A chain relaunch resets the index: its state no longer counts.
    fake.setState({ last_full_at: null, network: NETWORK });
    now += CHAIN_READY_CACHE_MS - 1;
    expect(await readsTheChain(scope, fake)).toBe(true);
    now += 2;
    expect(await readsTheChain(scope, fake)).toBe(false);
    // Read again at once: not ready is now the reading.
    expect(await readsTheChain(scope, fake)).toBe(false);
  });

  it('reuses not ready for CHAIN_NOT_READY_CACHE_MS, then reads ready', async () => {
    expect(CHAIN_NOT_READY_CACHE_MS).toBe(30_000);
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fake = fakeDb({ state: null });
    const { scope } = service(fake.db, true, {});
    expect(await readsTheChain(scope, fake)).toBe(false);
    fake.setState({ last_full_at: 1, network: NETWORK });
    now += CHAIN_NOT_READY_CACHE_MS - 1;
    expect(await readsTheChain(scope, fake)).toBe(false);
    expect(fake.of(`from ${CHAIN_INDEX_STATE_TABLE_NAME}`)).toHaveLength(1);
    now += 2;
    expect(await readsTheChain(scope, fake)).toBe(true);
  });
});

describe('statement sizes', () => {
  // The longest ids a statement can carry: a wave or group made on the
  // chain keeps its 66-character chain id.
  const ids = (n: number) =>
    Array.from(
      { length: n },
      () => '0x' + randomUUID().replace(/-/g, '').repeat(2)
    );
  const formattedBytes = (statement: {
    sql: string;
    params: Record<string, unknown>;
  }) =>
    Buffer.byteLength(formatNamedParameters(statement.sql, statement.params));

  beforeEach(() => {
    process.env.WAVES_FREEZE_AT = '2026-11-27T00:00:00Z';
    process.env[RECORDS_WAVE_ID_ENV] = ids(1)[0];
    process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
  });

  it.each([false, true])(
    'reads wave scopes in statements of at most 80 chain ids, each under the pin size (switched on: %s)',
    async (switchedOn) => {
      const fake = fakeDb();
      const { scope } = service(fake.db, switchedOn);
      const waveIds = ids(200);
      expect(waveIds[0]).toHaveLength(66);
      const scopes = await scope.waveScopes(waveIds, {});
      expect(scopes.size).toBe(200);
      const reads = fake.of('where w.id in');
      expect(reads.map((it) => it.params.waveIds.length)).toEqual([
        SCOPE_WAVE_IDS_PER_STATEMENT,
        SCOPE_WAVE_IDS_PER_STATEMENT,
        40
      ]);
      for (const read of reads)
        expect(formattedBytes(read)).toBeLessThan(PROXY_PIN_STATEMENT_BYTES);
    }
  );

  it.each([false, true])(
    'asks about groups in statements of at most 10 chain ids, each under the pin size (switched on: %s)',
    async (switchedOn) => {
      const groupIds = ids(25);
      const fake = fakeDb({ usedIn: [groupIds[24]] });
      const { scope } = service(fake.db, switchedOn);
      expect(await scope.usedByMovingWave(groupIds, {})).toBe(true);
      const asks = fake.of('as used');
      expect(asks.map((it) => it.params.groupIds.length)).toEqual([
        SCOPE_GROUP_IDS_PER_STATEMENT,
        SCOPE_GROUP_IDS_PER_STATEMENT,
        5
      ]);
      for (const ask of asks)
        expect(formattedBytes(ask)).toBeLessThan(PROXY_PIN_STATEMENT_BYTES);
    }
  );
});

describe('with every waves setting unset', () => {
  it('logs no error on a cold start and a few scope reads', async () => {
    const logger = Logger.get('WAVES_SCOPE');
    const error = jest.spyOn(logger, 'error');
    const warn = jest.spyOn(logger, 'warn');
    const fake = fakeDb();
    const scope = new WavesScopeService(() => fake.db as any);
    await scope.waveScopes(['a', 'b'], {});
    await scope.waveStays('a', {});
    await scope.usedByMovingWave(['g'], {});
    await scope.movingWaveIds(['a'], {});
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [RECORDS_UNSET_MESSAGE],
      [NETWORK_UNSET_MESSAGE]
    ]);
  });
});
