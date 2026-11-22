import { isSameRelayWave, relayWaveKey } from './relay-wave-key';

const UUID = '8fe93d73-c2b4-4160-8417-dbe9d5cce669';
// DerivedId(uuid || 0^16, 0, 0x0501), computed independently with the
// legacy-snapshot tool's ce.derived_id (validator wave-relay waves.rs).
const KEY =
  '0x80eb789653deae6a0fdf3b75d461ab3b086309e14c1bc0c4c4b81a94c14326d7';

describe('relayWaveKey', () => {
  it("is a 6529.io wave's derived chain id, in any case, dashes optional", () => {
    expect(relayWaveKey(UUID)).toBe(KEY);
    expect(relayWaveKey(UUID.toUpperCase())).toBe(KEY);
    expect(relayWaveKey(UUID.replace(/-/g, ''))).toBe(KEY);
  });

  it('names a chain id by itself, lowercase', () => {
    expect(relayWaveKey(KEY)).toBe(KEY);
    expect(relayWaveKey(KEY.toUpperCase().replace('0X', '0x'))).toBe(KEY);
  });

  it('names nothing else', () => {
    for (const name of [
      '',
      'w',
      'another-wave',
      'ps/0x01',
      '8fe93d73-c2b4-4160-8417-dbe9d5cce66',
      '8fe93d73c-2b4-4160-8417-dbe9d5cce669',
      '0x1234'
    ]) {
      expect(relayWaveKey(name)).toBeNull();
    }
  });

  it('tells a frame wave and a signed wave are one', () => {
    expect(isSameRelayWave(KEY, UUID)).toBe(true);
    expect(isSameRelayWave(UUID, UUID)).toBe(true);
    expect(isSameRelayWave('wave-1', 'wave-1')).toBe(true);
    expect(isSameRelayWave(KEY, 'wave-1')).toBe(false);
    expect(isSameRelayWave('wave-2', 'wave-1')).toBe(false);
  });
});
