import { Logger } from '@/logging';
import { WaveRelayPublisher } from './wave-relay-publisher';
import {
  runWaveRelayPublishing,
  waveRelayPublishConfig,
  WaveRelayPublishConfigError
} from './wave-relay-publish';

const on = {
  FEATURE_WAVES_RELAY_PUBLISH: 'true',
  WAVES_RELAY_URLS:
    ' wss://a.example/crp , wss://b.example ,wss://a.example/crp',
  WAVES_RELAY_NET: '6529-chain-1'
};

describe('waveRelayPublishConfig', () => {
  it('is off unless the flag is on', async () => {
    expect(waveRelayPublishConfig({})).toBeNull();
    expect(
      waveRelayPublishConfig({ ...on, FEATURE_WAVES_RELAY_PUBLISH: 'TRUE' })
    ).toBeNull();
    await expect(runWaveRelayPublishing({ env: {} })).resolves.toBeNull();
  });

  it('reads the relays, once each, and the network', () => {
    expect(waveRelayPublishConfig(on)).toEqual({
      relays: ['wss://a.example/crp', 'wss://b.example'],
      net: '6529-chain-1',
      includeMembersOnly: false
    });
    expect(
      waveRelayPublishConfig({
        ...on,
        FEATURE_WAVES_RELAY_PUBLISH_MEMBERS_ONLY: 'true'
      })?.includeMembersOnly
    ).toBe(true);
  });

  it.each([
    [{ WAVES_RELAY_URLS: '' }, 'names no relay'],
    [{ WAVES_RELAY_URLS: 'https://a.example' }, 'not a ws:// or wss://'],
    [{ WAVES_RELAY_URLS: 'wss://a b' }, 'not a ws:// or wss://'],
    [{ WAVES_RELAY_NET: ' ' }, 'WAVES_RELAY_NET']
  ])('refuses %j', (change, message) => {
    expect(() => waveRelayPublishConfig({ ...on, ...change })).toThrow(
      WaveRelayPublishConfigError
    );
    expect(() => waveRelayPublishConfig({ ...on, ...change })).toThrow(message);
  });
});

describe('runWaveRelayPublishing: runs that publish nothing say why, every run', () => {
  const SWITCH_ON = Date.UTC(2026, 10, 27);
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest
      .spyOn(Logger.prototype, 'info')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });

  /** A database whose chain index state is `state`; it must read nothing else. */
  const aScopeDb = (state: Record<string, unknown> | null) => {
    const reads: string[] = [];
    const db = {
      execute: async (sql: string) => {
        reads.push(sql);
        // The records wave's check: no waves row has its id.
        if (sql.includes('from waves where id = :id')) return [];
        if (!sql.includes('from waves_chain_index_state')) {
          throw new Error(`read more than the index's state: ${sql}`);
        }
        return state ? [state] : [];
      }
    };
    return { reads, scopeDb: () => db as any };
  };

  it('publishes and reads nothing before the switch-on, however early the flag is set, and says so once', async () => {
    const { reads, scopeDb } = aScopeDb(null);
    // Not even the records wave's setting is looked at before then.
    const env = { ...on, WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z' };
    for (let run = 0; run < 3; run++) {
      await expect(
        runWaveRelayPublishing({ env, scopeDb, now: () => SWITCH_ON - 1 })
      ).resolves.toEqual([]);
    }
    expect(reads).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(
      info.mock.calls.filter((c) =>
        String(c[0]).startsWith(
          '[WAVE RELAY PUBLISHING WAITS FOR THE SWITCH-ON]'
        )
      )
    ).toEqual([
      [
        '[WAVE RELAY PUBLISHING WAITS FOR THE SWITCH-ON] [WAVES_SWITCH_ON_AT 2026-11-27T00:00:00Z] [NOTHING IS PUBLISHED OR PASSED OVER UNTIL THEN]'
      ]
    ]);
    // Unset, or not a time: it never switches on.
    for (const at of [undefined, 'Saturday']) {
      await expect(
        runWaveRelayPublishing({
          env: { ...on, WAVES_SWITCH_ON_AT: at },
          scopeDb,
          now: () => SWITCH_ON + 1
        })
      ).resolves.toEqual([]);
    }
    expect(reads).toEqual([]);
  });

  it("starts at the switch-on time in the same process, from each relay's cursor", async () => {
    const { reads, scopeDb } = aScopeDb({
      name: 'waves',
      last_full_at: '1764201600000',
      network: `0x${'ab'.repeat(32)}`,
      last_error: null,
      read_time: '1764201690000'
    });
    const publish = jest
      .spyOn(WaveRelayPublisher.prototype, 'publishPending')
      .mockResolvedValue([]);
    const clock = { now: SWITCH_ON - 60_000 };
    const env = {
      ...on,
      WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z',
      SIGNED_RECORDS_WAVE_ID: 'none'
    };
    const run = () =>
      runWaveRelayPublishing({ env, scopeDb, now: () => clock.now });
    await run();
    expect(publish).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    clock.now = SWITCH_ON;
    await run();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        relays: ['wss://a.example/crp', 'wss://b.example'],
        maxPerRelayRun: 600
      })
    );
    publish.mockRestore();
  });

  it("holds after the switch-on until the index's full read, with a warning and its reason each run", async () => {
    const { scopeDb } = aScopeDb({
      name: 'waves',
      last_full_at: null,
      network: `0x${'ab'.repeat(32)}`,
      last_error: 'gateway down'
    });
    const env = {
      ...on,
      FEATURE_WAVES_ON_CHAIN: 'true',
      SIGNED_RECORDS_WAVE_ID: 'none'
    };
    for (let run = 0; run < 3; run++) {
      await expect(
        runWaveRelayPublishing({ env, scopeDb, now: () => SWITCH_ON })
      ).resolves.toEqual([]);
    }
    const holds = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith(
        '[WAVE RELAY PUBLISHING HOLDS AFTER THE SWITCH-ON]'
      )
    );
    expect(holds).toHaveLength(3);
    expect(String(holds[0][0])).toContain(
      '[THE CHAIN INDEX HAS NOT FINISHED A FULL READ] [INDEX ERROR gateway down]'
    );
    expect(error).not.toHaveBeenCalled();
  });
});
