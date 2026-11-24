import { Logger } from '@/logging';
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
  beforeEach(() => {
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
  });

  /** A database whose chain index state is `state`; it must read nothing else. */
  const aScopeDb = (state: Record<string, unknown> | null) => {
    const reads: string[] = [];
    const db = {
      execute: async (sql: string) => {
        reads.push(sql);
        if (!sql.includes('from waves_chain_index_state')) {
          throw new Error(`read more than the index's state: ${sql}`);
        }
        return state ? [state] : [];
      }
    };
    return { reads, scopeDb: () => db as any };
  };

  it('refuses before the switch-on while SIGNED_RECORDS_WAVE_ID is not set, with an error each run', async () => {
    const { reads, scopeDb } = aScopeDb(null);
    const env = { ...on, WAVES_SWITCH_ON_AT: '2026-11-27T00:00:00Z' };
    for (let run = 0; run < 2; run++) {
      await expect(
        runWaveRelayPublishing({ env, scopeDb, now: () => SWITCH_ON - 1 })
      ).resolves.toEqual([]);
    }
    const refusals = error.mock.calls.filter((c) =>
      String(c[0]).startsWith('[WAVE RELAY PUBLISHING REFUSED]')
    );
    expect(refusals).toHaveLength(2);
    expect(String(refusals[0][0])).toContain(
      'SIGNED_RECORDS_WAVE_ID IS NOT SET'
    );
    expect(reads).toEqual([]);
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
