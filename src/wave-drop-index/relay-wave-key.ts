import { ethers } from 'ethers';

/**
 * The key a relay keeps a wave under (validator wave-relay waves.rs
 * `wave_key`): a chain WAVE id as written (`0x` and 64 hex digits, any
 * case), or a 6529.io wave UUID's derived id,
 * `DerivedId(uuid || 16 zero bytes, 0, WAVE 0x0501)` with
 * `DerivedId = keccak256(keccak256("6529.DerivedId.v1") || parent ||
 * uint256(index) || uint256(kind))`, in lowercase hex. Null for any other
 * name. A subscription to every wave (`*`) names each wave by its key; the
 * signed `wave` field keeps the name its author signed.
 */
export function relayWaveKey(name: string): string | null {
  if (/^0x[0-9a-fA-F]{64}$/.test(name)) return name.toLowerCase();
  const hex = name.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  // Dashes optional, but only where a UUID has them.
  if (
    name.includes('-') &&
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      name
    )
  ) {
    return null;
  }
  const parent = ethers.concat([
    ethers.getBytes(`0x${hex}`),
    new Uint8Array(16)
  ]);
  return ethers
    .keccak256(
      ethers.concat([
        ethers.keccak256(ethers.toUtf8Bytes('6529.DerivedId.v1')),
        parent,
        ethers.zeroPadValue(ethers.toBeHex(0), 32),
        ethers.zeroPadValue(ethers.toBeHex(0x0501), 32)
      ])
    )
    .toLowerCase();
}

/** Whether a frame's wave name and an event's signed wave are one wave. */
export function isSameRelayWave(
  frameWave: string,
  signedWave: string
): boolean {
  if (frameWave === signedWave) return true;
  const frameKey = relayWaveKey(frameWave);
  return frameKey !== null && frameKey === relayWaveKey(signedWave);
}
