import { DbPoolName } from '@/db-query.options';
import { waveOnChainSql } from '@/waves-chain-index/waves-chain-mapping';
import { wavesScopeSql } from '@/waves-scope/waves-scope';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import { START_CURSOR } from './wave-relay-publisher';
import {
  parseSwitchOnAt,
  relayScopeMode,
  stayingWaveSql,
  WaveRelayScope,
  wavesSwitchedOn
} from './wave-relay-scope';

type Call = { sql: string; params?: Record<string, any>; options?: any };

const NET = `0x${'ab'.repeat(32)}`;
const SWITCH_ON = Date.UTC(2026, 10, 27);

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
const fullRead = (network = NET) => ({
  last_full_at: '1764201600000',
  network,
  last_error: null,
  feed_next: '101',
  read_height: '100',
  feed_part: 0,
  full_phase: null,
  updated_at: '1764201700000'
});

const BEFORE = { WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z' };
const AFTER_ENV = {
  WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z',
  WAVES_SETTLEMENT_NETWORK_ID: NET
};

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

describe('relayScopeMode', () => {
  const options = { forcePool: DbPoolName.WRITE };

  it('is the rule before the switch-on, without reading the index', async () => {
    const fake = anExecutor(fullRead());
    expect(
      await relayScopeMode(fake.executor(), options, BEFORE, SWITCH_ON - 1)
    ).toBe('rule');
    expect(fake.calls).toEqual([]);
  });

  it("is the chain's after the switch-on once the index has a full read on the chain's network; holds before", async () => {
    const mode = async (state: Record<string, unknown> | null | 'missing') =>
      relayScopeMode(
        anExecutor(state).executor(),
        options,
        AFTER_ENV,
        SWITCH_ON
      );
    expect(await mode(fullRead())).toBe('chain');
    expect(await mode(fullRead(NET.toUpperCase().replace('0X', '0x')))).toBe(
      'chain'
    );
    expect(await mode({ ...fullRead(), last_full_at: null })).toBe('hold');
    expect(await mode(null)).toBe('hold');
    expect(await mode('missing')).toBe('hold');
    // Another chain's full read (one the index read before) is not it.
    expect(await mode(fullRead(`0x${'cd'.repeat(32)}`))).toBe('hold');
    // No network named: any full read counts.
    expect(
      await relayScopeMode(
        anExecutor(fullRead(`0x${'cd'.repeat(32)}`)).executor(),
        options,
        BEFORE,
        SWITCH_ON
      )
    ).toBe('chain');
  });
});

describe('stayingWaveSql', () => {
  it('is the rule, subwaves of a staying wave included, before the switch-on', () => {
    expect(stayingWaveSql('w', 'rule')).toBe(wavesScopeSql('w').stays);
    expect(stayingWaveSql('w', 'rule')).toContain('w_anc');
    expect(stayingWaveSql('w', 'rule')).not.toContain('chain_waves');
  });

  it("is the chain's mapping after: a wave stays unless the chain holds it; direct messages and the records wave always", () => {
    const sql = stayingWaveSql('w', 'chain');
    expect(sql).toBe(
      wavesScopeSql('w', 'recordsWaveId', {
        switchedOn: true,
        heldSql: waveOnChainSql
      }).stays
    );
    expect(sql).toContain(waveOnChainSql('w.id'));
    expect(sql).toContain(':recordsWaveId');
    expect(sql).toContain('is_direct_message');
    expect(sql).not.toContain('w_anc');
  });
});

describe('WaveRelayScope.staysOnSite (the API)', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of [
      'SIGNED_RECORDS_WAVE_ID',
      'WAVES_SWITCH_ON_AT',
      'FEATURE_WAVES_ON_CHAIN',
      'WAVES_SETTLEMENT_NETWORK_ID'
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  const staysWith = async (state: Record<string, unknown> | null) => {
    const fake = anExecutor(state, () => [{ stays: 1 }]);
    const stays = await new WaveRelayScope(fake.executor).staysOnSite('wave-1');
    return { stays, fake };
  };

  it('reads the rule on the writer before the switch-on', async () => {
    process.env.SIGNED_RECORDS_WAVE_ID = 'records-wave';
    delete process.env.FEATURE_WAVES_ON_CHAIN;
    process.env.WAVES_SWITCH_ON_AT = '2099-01-01T00:00:00Z';
    const { stays, fake } = await staysWith(fullRead());
    expect(stays).toBe(true);
    const read = fake.calls.find((c) => c.sql.includes('as stays'))!;
    expect(read.sql).toContain(stayingWaveSql('w', 'rule'));
    expect(read.params).toEqual({
      waveId: 'wave-1',
      recordsWaveId: 'records-wave'
    });
    expect(fake.calls.map((c) => c.options)).toEqual(
      fake.calls.map(() => ({ forcePool: DbPoolName.WRITE }))
    );
  });

  it("keeps the rule after the switch-on until the index's full read, so a moving wave still needs signatures; then the mapping", async () => {
    process.env.FEATURE_WAVES_ON_CHAIN = 'true';
    process.env.WAVES_SETTLEMENT_NETWORK_ID = NET;
    const holding = await staysWith({ ...fullRead(), last_full_at: null });
    expect(
      holding.fake.calls.find((c) => c.sql.includes('as stays'))!.sql
    ).toContain(stayingWaveSql('w', 'rule'));
    const other = await staysWith(fullRead(`0x${'cd'.repeat(32)}`));
    expect(
      other.fake.calls.find((c) => c.sql.includes('as stays'))!.sql
    ).toContain(stayingWaveSql('w', 'rule'));
    const ready = await staysWith(fullRead());
    expect(
      ready.fake.calls.find((c) => c.sql.includes('as stays'))!.sql
    ).toContain(stayingWaveSql('w', 'chain'));
  });

  it('is false for a wave with no row, and with no records wave set', async () => {
    delete process.env.SIGNED_RECORDS_WAVE_ID;
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
  const read = (
    state: Record<string, unknown> | null | 'missing',
    env: Record<string, string | undefined>,
    recordsWaveId: string | null = 'records-wave'
  ) => {
    const fake = anExecutor(state);
    const db = new WaveRelayPublishDb(
      fake.executor,
      moderation,
      env,
      () => SWITCH_ON
    );
    return {
      fake,
      run: () =>
        db.candidatesAfter(START_CURSOR, 5_000, 20, {
          includeMembersOnly: true,
          recordsWaveId
        })
    };
  };
  const candidatesCall = (calls: Call[]) =>
    calls.find((c) => c.sql.includes('device_signed_events'));

  it('leaves out every wave the rule keeps on 6529.io before the switch-on, whatever the index says', async () => {
    for (const state of ['missing', null, fullRead()] as const) {
      const { fake, run } = read(state, {
        WAVES_SWITCH_ON_AT: '2099-01-01T00:00:00Z'
      });
      await run();
      const call = candidatesCall(fake.calls)!;
      expect(call.sql).toContain(`and not ${stayingWaveSql('w', 'rule')}`);
      expect(call.params).toMatchObject({ recordsWaveId: 'records-wave' });
    }
  });

  it("reads nothing after the switch-on until the index has a full read on the chain's network, so the cursor holds every event", async () => {
    for (const state of [
      'missing',
      null,
      { ...fullRead(), last_full_at: null },
      fullRead(`0x${'cd'.repeat(32)}`)
    ] as const) {
      const { fake, run } = read(state, AFTER_ENV);
      expect(await run()).toEqual([]);
      expect(candidatesCall(fake.calls)).toBeUndefined();
    }
  });

  it("leaves out every wave the chain doesn't hold after, and the records wave", async () => {
    const { fake, run } = read(fullRead(), AFTER_ENV);
    await run();
    const call = candidatesCall(fake.calls)!;
    expect(call.sql).toContain(`and not ${stayingWaveSql('w', 'chain')}`);
    expect(call.params).toMatchObject({ recordsWaveId: 'records-wave' });
    // The index's state is read on the writer, as the events are.
    expect(fake.calls[0].options).toEqual({ forcePool: DbPoolName.WRITE });
  });

  it('runs with no records wave', async () => {
    const { fake, run } = read(fullRead(), AFTER_ENV, null);
    await run();
    expect(candidatesCall(fake.calls)!.params).toMatchObject({
      recordsWaveId: null
    });
  });

  it('still never reads direct messages, nor members-only waves unless asked', async () => {
    const fake = anExecutor(null);
    await new WaveRelayPublishDb(
      fake.executor,
      moderation,
      {},
      () => SWITCH_ON
    ).candidatesAfter(START_CURSOR, 5_000, 20, {
      includeMembersOnly: false,
      recordsWaveId: null
    });
    const call = candidatesCall(fake.calls)!;
    expect(call.sql).toContain('coalesce(w.is_direct_message, 0) = 0');
    expect(call.sql).toContain(
      'and w.visibility_group_id is null and pw.visibility_group_id is null'
    );
  });
});
