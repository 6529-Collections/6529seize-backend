import { RelayCheckResult, RelayItem } from '@/rebuild/manifest.types';
import { checkRelayEvent } from '@/wave-drop-index/relay-event-check';

/**
 * The waves area's check of a recorded relay event: the drop index's own
 * (src/wave-drop-index, as wave-events checks it): the event id recomputed from its fields,
 * the body's hash and size, the Ed25519 signature by the device key, and
 * the grant's wallet signature, scope and life. A recording edited by hand
 * fails it. 6529.io's own grants are not consulted: the recording stands
 * alone.
 */
export function checkWavesRelayEvent(item: RelayItem): RelayCheckResult {
  const check = checkRelayEvent(
    item.event as Record<string, unknown>,
    item.grant as Record<string, unknown>,
    null
  );
  return check.ok ? { ok: true } : { ok: false, reason: check.reason };
}
