import { DbPoolName } from '@/db-query.options';
import { waveOnChainSql } from '@/waves-chain-index/waves-chain-mapping';
import { SCOPE_SQL_PARAMS, wavesScopeSql } from '@/waves-scope/waves-scope';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import { START_CURSOR } from './wave-relay-publisher';
import {
  parseSwitchOnAt,
  recordsWaveSetting,
  relayRunScope,
  relayScopeMode,
  scopeSqlParamValues,
  stayingWaveSql,
  WaveRelayScope,
  wavesSwitchedOn
} from './wave-relay-scope';

type Call = { sql: string; params?: Record<string, any>; options?: any };

const NET = `0x${'ab'.repeat(32)}`;
const SWITCH_ON = Date.UTC(2026, 10, 27);
const FREEZE = Date.UTC(2026, 10, 25);

/**
 * A fake executor: the chain index's state row is `state` (null: no row;
 * 'missing': the index's tables aren't there).
 */
function anExecutor(
  state: Record<string, unknown> | null | 'missing',
  answer: (sql: string) => unknown[] = () => []
) {
  const calls: Call[] = [];
  const execute = async (
    sql: string,
    params?: Record<string, any>,
    options?: any
  ) => {
    calls.push({ sql, params, options });
    if (sql.includes('from waves_chain_index_state')) {
      if (state === 'missing') {
        throw Object.assign(new Error('no such table'), {
          code: 'ER_NO_SUCH_TABLE'
        });
      }
      return state ? [state] : [];
    }
    return answer(sql);
  };
  const executor = {
    execute,
    oneOrNull: async (sql: string, params?: any, options?: any) =>
      (await execute(sql, params, options))[0] ?? null,
    executeNativeQueriesInTransaction: async (fn: any) => fn({ connection: {} })
  };
  return { calls, executor: () => executor as any };
}

/** The state row of an index that has finished a full read on `network`. */
const fullRead = (network = NET, fields: Record<string, unknown> = {}) => ({
  name: 'waves',
  last_full_at: '1764201600000',
  network,
  last_error: null,
  feed_next: '101',
  read_height: '100',
  read_time: '1764201690000',
  feed_part: 0,
  full_phase: null,
  updated_at: '1764201700000',
  ...fields
});

const BEFORE = { WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z' };
const AFTER_ENV = {
  WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z',
  WAVES_SETTLEMENT_NETWORK_ID: NET
};
const options = { forcePool: DbPoolName.WRITE };

describe('the switch-on', () => {
  it('reads WAVES_SWITCH_ON_AT as the waves freeze reads WAVES_FREEZE_AT', () => {
    expect(parseSwitchOnAt(undefined)).toBeUndefined();
    expect(parseSwitchOnAt(' ')).toBeUndefined();
    expect(parseSwitchOnAt('2026-11-27T00:00:00Z')).toBe(SWITCH_ON);
    expect(parseSwitchOnAt('2026-11-26T24:00Z')).toBe(SWITCH_ON);
    expect(parseSwitchOnAt(String(SWITCH_ON))).toBe(SWITCH_ON);
    for (const bad of [
      '0',
      'false',
      '1764201600',
      '2026-11-31T00:00:00Z',
      '2026-11-27T00:00:00',
      '2026-11-26T24:01Z',
      '2100-01-01T00:00:00Z'
    ]) {
      expect(parseSwitchOnAt(bad)).toBeNull();
    }
  });

  it('takes no day that does not exist, even at 24:00', () => {
    // Date.parse moves these into the next month; 24:00 skips the later
    // check that would catch it, so only the day check refuses them.
    for (const bad of [
      '2026-11-31T24:00Z',
      '2026-02-30T24:00:00Z',
      '2026-02-29T24:00Z'
    ]) {
      expect(parseSwitchOnAt(bad)).toBeNull();
    }
    expect(parseSwitchOnAt('2028-02-29T24:00Z')).toBe(Date.UTC(2028, 2, 1));
  });

  it('is on from WAVES_SWITCH_ON_AT, or with FEATURE_WAVES_ON_CHAIN; a bad time is not', () => {
    expect(wavesSwitchedOn({}, SWITCH_ON)).toBe(false);
    expect(wavesSwitchedOn(BEFORE, SWITCH_ON - 1)).toBe(false);
    expect(wavesSwitchedOn(BEFORE, SWITCH_ON)).toBe(true);
    expect(wavesSwitchedOn({ FEATURE_WAVES_ON_CHAIN: 'true' }, 0)).toBe(true);
    expect(wavesSwitchedOn({ FEATURE_WAVES_ON_CHAIN: 'TRUE' }, 0)).toBe(false);
    expect(
      wavesSwitchedOn({ WAVES_SWITCH_ON_AT: 'tomorrow' }, SWITCH_ON * 2)
    ).toBe(false);
  });
});

describe('the records wave setting', () => {
  it('is an id, none on purpose, or unset', () => {
    expect(recordsWaveSetting({ SIGNED_RECORDS_WAVE_ID: ' w-1 ' })).toEqual({
      kind: 'id',
      id: 'w-1'
    });
    expect(recordsWaveSetting({ SIGNED_RECORDS_WAVE_ID: ' none ' })).toEqual({
      kind: 'none'
    });
    for (const unset of [{}, { SIGNED_RECORDS_WAVE_ID: '  ' }]) {
      expect(recordsWaveSetting(unset)).toEqual({ kind: 'unset' });
    }
    // Only `none` itself: `None` is an id (one that names no wave).
    expect(recordsWaveSetting({ SIGNED_RECORDS_WAVE_ID: 'None' })).toEqual({
      kind: 'id',
      id: 'None'
    });
  });

  it("fills exactly the module's SQL parameters", () => {
    expect(Object.keys(scopeSqlParamValues(null, {})).sort()).toEqual(
      Object.values(SCOPE_SQL_PARAMS).sort()
    );
  });

  it('gives the SQL form its parameters: the records wave and the freeze time', () => {
    expect(
      scopeSqlParamValues('w-1', { WAVES_FREEZE_AT: '2026-11-25T00:00:00Z' })
    ).toEqual({
      [SCOPE_SQL_PARAMS.records]: 'w-1',
      [SCOPE_SQL_PARAMS.freezeAtMs]: FREEZE,
      [SCOPE_SQL_PARAMS.freezeAt]: new Date(FREEZE)
    });
    for (const env of [{}, { WAVES_FREEZE_AT: 'soon' }]) {
      expect(scopeSqlParamValues(null, env)).toEqual({
        [SCOPE_SQL_PARAMS.records]: null,
        [SCOPE_SQL_PARAMS.freezeAtMs]: null,
        [SCOPE_SQL_PARAMS.freezeAt]: null
      });
    }
  });
});

describe('relayScopeMode', () => {
  it('is the rule before the switch-on, without reading the index', async () => {
    const fake = anExecutor(fullRead());
    expect(
      (await relayScopeMode(fake.executor(), options, BEFORE, SWITCH_ON - 1))
        .mode
    ).toBe('rule');
    expect(fake.calls).toEqual([]);
  });

  it("is the chain's after the switch-on once the index has a full read on the chain's network; holds before", async () => {
    const mode = async (state: Record<string, unknown> | null | 'missing') =>
      (
        await relayScopeMode(
          anExecutor(state).executor(),
          options,
          AFTER_ENV,
          SWITCH_ON
        )
      ).mode;
    expect(await mode(fullRead())).toBe('chain');
    expect(await mode(fullRead(NET.toUpperCase().replace('0X', '0x')))).toBe(
      'chain'
    );
    expect(await mode(fullRead(NET, { last_full_at: null }))).toBe('hold');
    expect(await mode(null)).toBe('hold');
    expect(await mode('missing')).toBe('hold');
    expect(await mode(fullRead(`0x${'cd'.repeat(32)}`))).toBe('hold');
    // No network named: any full read counts.
    expect(
      (
        await relayScopeMode(
          anExecutor(fullRead(`0x${'cd'.repeat(32)}`)).executor(),
          options,
          BEFORE,
          SWITCH_ON
        )
      ).mode
    ).toBe('chain');
  });
});

describe('relayRunScope: one run publishes, holds or refuses', () => {
  const scope = (
    state: Record<string, unknown> | null | 'missing',
    env: Record<string, string>,
    now: number
  ) => relayRunScope(anExecutor(state).executor(), options, env, now);

  it('publishes by the rule before the switch-on with the records wave named, or none on purpose', async () => {
    expect(
      await scope(
        null,
        { ...BEFORE, SIGNED_RECORDS_WAVE_ID: 'records-wave' },
        SWITCH_ON - 1
      )
    ).toEqual({ publish: true, mode: 'rule', recordsWaveId: 'records-wave' });
    expect(
      await scope(null, { ...BEFORE, SIGNED_RECORDS_WAVE_ID: 'none' }, 0)
    ).toEqual({ publish: true, mode: 'rule', recordsWaveId: null });
  });

  it('refuses before the switch-on when the records wave is not set: it would go to the relays', async () => {
    const refused = await scope(null, BEFORE, SWITCH_ON - 1);
    expect(refused).toMatchObject({ publish: false, level: 'error' });
    expect((refused as { reason: string }).reason).toContain(
      'SIGNED_RECORDS_WAVE_ID IS NOT SET'
    );
  });

  it("publishes by the chain's mapping after the switch-on, the records wave set or not", async () => {
    expect(await scope(fullRead(), AFTER_ENV, SWITCH_ON)).toEqual({
      publish: true,
      mode: 'chain',
      recordsWaveId: null
    });
    expect(
      await scope(
        fullRead(),
        { ...AFTER_ENV, SIGNED_RECORDS_WAVE_ID: 'records-wave' },
        SWITCH_ON
      )
    ).toEqual({ publish: true, mode: 'chain', recordsWaveId: 'records-wave' });
  });

  it('holds after the switch-on with the reason, until the index has a full read on the network', async () => {
    const cases: [Record<string, unknown> | null | 'missing', string][] = [
      ['missing', "THE CHAIN INDEX'S TABLES ARE NOT THERE"],
      [null, 'THE CHAIN INDEX HAS NOT RUN'],
      [
        fullRead(NET, { last_full_at: null, last_error: 'gateway down' }),
        'THE CHAIN INDEX HAS NOT FINISHED A FULL READ] [INDEX ERROR gateway down]'
      ],
      [
        fullRead(`0x${'cd'.repeat(32)}`),
        'THE CHAIN INDEX IS ON ANOTHER NETWORK THAN WAVES_SETTLEMENT_NETWORK_ID'
      ]
    ];
    for (const [state, why] of cases) {
      const held = await scope(state, AFTER_ENV, SWITCH_ON);
      expect(held).toMatchObject({ publish: false, level: 'warn' });
      const reason = (held as { reason: string }).reason;
      expect(reason).toContain(
        '[WAVE RELAY PUBLISHING HOLDS AFTER THE SWITCH-ON]'
      );
      expect(reason).toContain(why);
    }
  });
});

describe('stayingWaveSql', () => {
  it('is the rule, subwaves of a staying wave included, before the switch-on', () => {
    expect(stayingWaveSql('w', 'rule')).toBe(wavesScopeSql('w').stays);
    expect(stayingWaveSql('w', 'rule')).toContain('w_anc');
    expect(stayingWaveSql('w', 'rule')).not.toContain('chain_waves');
  });

  it("is the rule with a chain-made wave moved after the switch-on, before the index's full read", () => {
    expect(stayingWaveSql('w', 'not_ready')).toBe(
      wavesScopeSql('w', { switchedOn: true, heldSql: null }).stays
    );
    expect(stayingWaveSql('w', 'not_ready')).toContain('w_anc');
    expect(stayingWaveSql('w', 'not_ready')).toContain("regexp '^0x");
  });

  it("is the chain's mapping after: a wave stays unless the chain holds it", () => {
    const sql = stayingWaveSql('w', 'chain');
    expect(sql).toBe(
      wavesScopeSql('w', { switchedOn: true, heldSql: waveOnChainSql }).stays
    );
    expect(sql).toContain(waveOnChainSql('w.id'));
    expect(sql).toContain(':recordsWaveId');
    expect(sql).not.toContain('w_anc');
  });
});

describe('WaveRelayScope.staysOnSite (the API)', () => {
  const keys = [
    'SIGNED_RECORDS_WAVE_ID',
    'WAVES_SWITCH_ON_AT',
    'FEATURE_WAVES_ON_CHAIN',
    'WAVES_SETTLEMENT_NETWORK_ID',
    'WAVES_FREEZE_AT'
  ];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  const read = async (state: Record<string, unknown> | null) => {
    const fake = anExecutor(state, () => [{ stays: 1 }]);
    const stays = await new WaveRelayScope(fake.executor).staysOnSite('wave-1');
    return {
      stays,
      fake,
      call: fake.calls.find((c) => c.sql.includes('as stays'))!
    };
  };

  it('reads the rule on the writer before the switch-on, with the freeze time', async () => {
    process.env.SIGNED_RECORDS_WAVE_ID = 'records-wave';
    process.env.WAVES_FREEZE_AT = '2026-11-25T00:00:00Z';
    delete process.env.FEATURE_WAVES_ON_CHAIN;
    process.env.WAVES_SWITCH_ON_AT = '2099-01-01T00:00:00Z';
    const { stays, fake, call } = await read(fullRead());
    expect(stays).toBe(true);
    expect(call.sql).toContain(stayingWaveSql('w', 'rule'));
    expect(call.params).toEqual({
      waveId: 'wave-1',
      recordsWaveId: 'records-wave',
      freezeAtMs: FREEZE,
      freezeAt: new Date(FREEZE)
    });
    expect(fake.calls.map((c) => c.options)).toEqual(
      fake.calls.map(() => ({ forcePool: DbPoolName.WRITE }))
    );
  });

  it("reads the rule with a chain-made wave moved after the switch-on until the index's full read, so a moving wave still needs signatures; then the mapping", async () => {
    process.env.FEATURE_WAVES_ON_CHAIN = 'true';
    process.env.WAVES_SETTLEMENT_NETWORK_ID = NET;
    expect(
      (await read(fullRead(NET, { last_full_at: null }))).call.sql
    ).toContain(stayingWaveSql('w', 'not_ready'));
    expect((await read(fullRead(`0x${'cd'.repeat(32)}`))).call.sql).toContain(
      stayingWaveSql('w', 'not_ready')
    );
    expect((await read(fullRead())).call.sql).toContain(
      stayingWaveSql('w', 'chain')
    );
  });

  it('is false for a wave with no row; none is no records wave', async () => {
    process.env.SIGNED_RECORDS_WAVE_ID = 'none';
    process.env.FEATURE_WAVES_ON_CHAIN = 'true';
    const fake = anExecutor(fullRead(), () => []);
    expect(await new WaveRelayScope(fake.executor).staysOnSite('nowhere')).toBe(
      false
    );
    expect(
      fake.calls.find((c) => c.sql.includes('as stays'))!.params
    ).toMatchObject({ recordsWaveId: null });
  });
});

describe("WaveRelayPublishDb.candidatesAfter: only moving waves' events", () => {
  const moderation = { getPresentations: async () => ({}) } as any;
  const params = scopeSqlParamValues('records-wave', {
    WAVES_FREEZE_AT: '2026-11-25T00:00:00Z'
  });
  const read = async (mode: 'rule' | 'chain', includeMembersOnly = true) => {
    const fake = anExecutor(null);
    await new WaveRelayPublishDb(fake.executor, moderation).candidatesAfter(
      START_CURSOR,
      5_000,
      20,
      { includeMembersOnly, mode, scopeParams: params }
    );
    return fake.calls.find((c) => c.sql.includes('device_signed_events'))!;
  };

  it('leaves out every wave the rule keeps on 6529.io, by the rule', async () => {
    const call = await read('rule');
    expect(call.sql).toContain(`and not ${stayingWaveSql('w', 'rule')}`);
    expect(call.params).toMatchObject({
      recordsWaveId: 'records-wave',
      freezeAtMs: FREEZE,
      freezeAt: new Date(FREEZE)
    });
  });

  it("leaves out every wave the chain doesn't hold, by the chain's mapping", async () => {
    const call = await read('chain');
    expect(call.sql).toContain(`and not ${stayingWaveSql('w', 'chain')}`);
    expect(call.params).toMatchObject({ recordsWaveId: 'records-wave' });
  });

  it('still never reads direct messages, nor members-only waves unless asked', async () => {
    const call = await read('rule', false);
    expect(call.sql).toContain('coalesce(w.is_direct_message, 0) = 0');
    expect(call.sql).toContain(
      'and w.visibility_group_id is null and pw.visibility_group_id is null'
    );
  });
});
