// Relay checks for the harness's own tests of the checking child.
import * as net from 'node:net';
import { RelayCheckResult, RelayItem } from '@/rebuild/manifest.types';

/** Passes every event whose flags say so. */
export function passWhenAllowed(
  _item: RelayItem,
  flags: Readonly<Record<string, string>>
): RelayCheckResult {
  return flags.ALLOW === 'yes'
    ? { ok: true }
    : { ok: false, reason: 'not allowed' };
}

/** Tries to reach a TEST-NET-1 host (RFC 5737), which the guard refuses. */
export function reachOut(): RelayCheckResult {
  const socket = net.connect(80, '192.0.2.1');
  socket.on('error', () => undefined);
  socket.destroy();
  return { ok: true };
}
