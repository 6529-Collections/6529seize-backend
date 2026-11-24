import { DbPoolName } from '@/db-query.options';
import { waveOnChainSql } from '@/waves-chain-index/waves-chain-mapping';
import { StayReason, wavesScopeSql } from '@/waves-scope/waves-scope';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import { START_CURSOR } from './wave-relay-publisher';
import { stayingWaveSql, WaveRelayScope } from './wave-relay-scope';

type Call = { sql: string; params?: Record<string, any>; options?: any };

/**
 * A fake executor: the chain index's state row answers `lastFullAt` (null:
 * no full read yet; 'missing': the index's tables aren't there).
 */
function anExecutor(
  lastFullAt: number | null | 'missing',
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
      if (lastFullAt === 'missing') {
        throw Object.assign(new Error('no such table'), {
          code: 'ER_NO_SUCH_TABLE'
        });
      }
      return [{ last_full_at: lastFullAt }];
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

const hiddenGroupWalk = 'community_groups w_g';
const chainWaves = waveOnChainSql('w.id');

describe('stayingWaveSql', () => {
  it('is the rule until the chain index has finished a full read', () => {
    expect(stayingWaveSql('w', false)).toBe(wavesScopeSql('w').stays);
    expect(stayingWaveSql('w', false)).toContain(hiddenGroupWalk);
    expect(stayingWaveSql('w', false)).not.toContain('chain_waves');
  });

  it("is the chain's mapping after, with direct messages and the records wave staying always", () => {
    const scope = wavesScopeSql('w');
    expect(stayingWaveSql('w', true)).toBe(
      `(${scope.reasons[StayReason.DIRECT_MESSAGE]} or ${scope.reasons[StayReason.RECORDS_WAVE]} or not ${chainWaves})`
    );
    expect(stayingWaveSql('w', true)).toContain(':recordsWaveId');
    expect(stayingWaveSql('w', true)).not.toContain(hiddenGroupWalk);
  });
});

describe('WaveRelayScope.staysOnSite', () => {
  const original = process.env.SIGNED_RECORDS_WAVE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.SIGNED_RECORDS_WAVE_ID;
    else process.env.SIGNED_RECORDS_WAVE_ID = original;
  });

  it('reads the wave on the writer with the rule, then the mapping', async () => {
    process.env.SIGNED_RECORDS_WAVE_ID = 'records-wave';
    const before = anExecutor('missing', () => [{ stays: 1 }]);
    expect(
      await new WaveRelayScope(before.executor).staysOnSite('wave-1')
    ).toBe(true);
    const read = before.calls[1];
    expect(read.sql).toContain(wavesScopeSql('w').stays);
    expect(read.params).toEqual({
      waveId: 'wave-1',
      recordsWaveId: 'records-wave'
    });
    expect(before.calls.map((c) => c.options)).toEqual([
      { forcePool: DbPoolName.WRITE },
      { forcePool: DbPoolName.WRITE }
    ]);
    const after = anExecutor(1764201600000, () => [{ stays: '0' }]);
    expect(await new WaveRelayScope(after.executor).staysOnSite('wave-1')).toBe(
      false
    );
    expect(after.calls[1].sql).toContain(stayingWaveSql('w', true));
    const none = anExecutor(1764201600000, () => []);
    expect(await new WaveRelayScope(none.executor).staysOnSite('nowhere')).toBe(
      false
    );
  });
});

describe("WaveRelayPublishDb.candidatesAfter: only moving waves' events", () => {
  const moderation = { getPresentations: async () => ({}) } as any;
  const read = (lastFullAt: number | null | 'missing') => {
    const fake = anExecutor(lastFullAt);
    return {
      fake,
      run: () =>
        new WaveRelayPublishDb(fake.executor, moderation).candidatesAfter(
          START_CURSOR,
          5_000,
          20,
          { includeMembersOnly: true, recordsWaveId: 'records-wave' }
        )
    };
  };
  const candidatesCall = (calls: Call[]) =>
    calls.find((c) => c.sql.includes('device_signed_events'))!;

  it('leaves out every wave the rule keeps on 6529.io before the chain index has a full read', async () => {
    for (const state of ['missing', null] as const) {
      const { fake, run } = read(state);
      await run();
      const call = candidatesCall(fake.calls);
      expect(call.sql).toContain(`and not ${stayingWaveSql('w', false)}`);
      expect(call.params).toMatchObject({ recordsWaveId: 'records-wave' });
    }
  });

  it("leaves out every wave the chain doesn't hold after, and the records wave", async () => {
    const { fake, run } = read(1764201600000);
    await run();
    const call = candidatesCall(fake.calls);
    expect(call.sql).toContain(`and not ${stayingWaveSql('w', true)}`);
    expect(call.sql).toContain(chainWaves);
    expect(call.params).toMatchObject({ recordsWaveId: 'records-wave' });
    // The index's state is read on the writer, as the events are.
    expect(fake.calls[0].options).toEqual({ forcePool: DbPoolName.WRITE });
  });

  it('still never reads direct messages, nor members-only waves unless asked', async () => {
    const fake = anExecutor(null);
    await new WaveRelayPublishDb(fake.executor, moderation).candidatesAfter(
      START_CURSOR,
      5_000,
      20,
      { includeMembersOnly: false, recordsWaveId: null }
    );
    const call = candidatesCall(fake.calls);
    expect(call.sql).toContain('coalesce(w.is_direct_message, 0) = 0');
    expect(call.sql).toContain(
      'and w.visibility_group_id is null and pw.visibility_group_id is null'
    );
    expect(call.params).toMatchObject({ recordsWaveId: null });
  });
});
