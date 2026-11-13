/**
 * The Redis Cluster hash slot of a key, as `CLUSTER KEYSLOT` computes it:
 * CRC16 (XMODEM) of the key, or of its first non-empty {hash tag}, mod 16384.
 * Tests use it to prove that every key one script touches is in one slot;
 * ElastiCache Serverless runs in cluster mode and rejects anything else with
 * CROSSSLOT.
 */
export function redisKeySlot(key: string): number {
  const open = key.indexOf('{');
  if (open >= 0) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) key = key.slice(open + 1, close);
  }
  let crc = 0;
  for (const byte of Array.from(Buffer.from(key, 'utf8'))) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16384;
}
