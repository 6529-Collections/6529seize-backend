import {
  runWaveRelayPublishing,
  waveRelayPublishConfig,
  WaveRelayPublishConfigError
} from './wave-relay-publish';

describe('waveRelayPublishConfig', () => {
  const on = {
    FEATURE_WAVES_RELAY_PUBLISH: 'true',
    WAVES_RELAY_URLS:
      ' wss://a.example/crp , wss://b.example ,wss://a.example/crp',
    WAVES_RELAY_NET: '6529-chain-1'
  };

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
      net: '6529-chain-1'
    });
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
