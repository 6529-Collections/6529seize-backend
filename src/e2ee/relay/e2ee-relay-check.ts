import {
  checkE2eeRecord,
  E2eeSignedRecordEvent,
  parseE2eeFamilyWave
} from '@/e2ee/relay/e2ee-record-event';

export type E2eeRelayItemCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const STRING_FIELDS = [
  'id',
  'wave',
  'author',
  'device_key',
  'auth_ref',
  'body_hash',
  'signature'
] as const;
const NUMBER_FIELDS = [
  'kind',
  'kind_version',
  'key_type',
  'seq',
  'anchor',
  'claimed_time',
  'body_size'
] as const;

/** Why an event is not shaped as a signed record, or null when it is. */
function shapeProblem(event: Record<string, unknown>): string | null {
  for (const field of STRING_FIELDS) {
    if (typeof event[field] !== 'string') return `${field} is not a string`;
  }
  for (const field of NUMBER_FIELDS) {
    if (typeof event[field] !== 'number') return `${field} is not a number`;
  }
  if (
    !Array.isArray(event.refs) ||
    !event.refs.every((ref) => typeof ref === 'string')
  ) {
    return 'refs is not a list of strings';
  }
  if (event.body !== null && typeof event.body !== 'string') {
    return 'body is neither a string nor null';
  }
  return null;
}

/**
 * The check a relay event of the encrypted-message streams must pass, as
 * the rebuild applies it: the wave is one of the orderer's families, and
 * the record's body hash, id and Ed25519 signature hold with the orderer's
 * pinned key (`E2EE_ORDERER_PUBLIC_KEY`). The rebuild check runs it on
 * every recorded relay event of the area.
 */
export function checkE2eeRelayItem(
  item: {
    readonly event: Record<string, unknown>;
    readonly grant: Record<string, unknown>;
  },
  flags: Readonly<Record<string, string>>
): E2eeRelayItemCheck {
  const ordererKey = flags.E2EE_ORDERER_PUBLIC_KEY;
  if (!ordererKey) {
    return { ok: false, reason: 'no E2EE_ORDERER_PUBLIC_KEY flag' };
  }
  const shape = shapeProblem(item.event);
  if (shape) return { ok: false, reason: `malformed event: ${shape}` };
  const event = item.event as unknown as E2eeSignedRecordEvent;
  if (!parseE2eeFamilyWave(event.wave)) {
    return { ok: false, reason: `wave ${event.wave} is not an e2ee stream` };
  }
  try {
    const check = checkE2eeRecord(event, ordererKey);
    return check.ok
      ? { ok: true }
      : { ok: false, reason: `not the orderer's record (${check.reason})` };
  } catch (error) {
    return {
      ok: false,
      reason: `malformed event: ${(error as Error).message}`
    };
  }
}
