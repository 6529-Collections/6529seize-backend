import { BadRequestException } from '@/exceptions';

/**
 * Upper bound on the number of wave ids one CREATE_DROP_TO_WAVE grant may
 * name. Mirrors `maxItems` on the OpenAPI request schemas.
 */
export const PROXY_WAVE_ALLOWLIST_MAX_ENTRIES = 100;
const WAVE_ID_MAX_LENGTH = 100;

/**
 * A grant's wave scope. `null` is the legacy, unrestricted grant. A non-empty
 * array restricts the grant to exactly those wave ids. An empty array is never
 * a valid stored value: it is rejected before persistence so a client can never
 * hold a grant whose restriction the server silently discarded.
 */
export type ProxyWaveAllowlist = readonly string[] | null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates a client-supplied allowlist. `undefined` and `null` both mean "no
 * restriction" and normalise to `null`; anything else must be a non-empty,
 * duplicate-free array of non-empty string ids within the size bound.
 * Throws a 400 for every malformed shape so nothing malformed is persisted.
 */
export function normalizeWaveAllowlist(input: unknown): string[] | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Array.isArray(input)) {
    throw new BadRequestException(
      'wave_allowlist must be an array of wave ids'
    );
  }
  if (input.length === 0) {
    throw new BadRequestException(
      'wave_allowlist must contain at least one wave id'
    );
  }
  if (input.length > PROXY_WAVE_ALLOWLIST_MAX_ENTRIES) {
    throw new BadRequestException(
      `wave_allowlist must contain at most ${PROXY_WAVE_ALLOWLIST_MAX_ENTRIES} wave ids`
    );
  }
  // A Set, not a plain object: an id such as "constructor" must not collide
  // with Object.prototype.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of input) {
    if (!isNonEmptyString(entry) || entry.length > WAVE_ID_MAX_LENGTH) {
      throw new BadRequestException(
        'wave_allowlist entries must be non-empty wave id strings'
      );
    }
    if (seen.has(entry)) {
      throw new BadRequestException(
        'wave_allowlist must not contain duplicates'
      );
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Decodes the stored `wave_allowlist` column. The MySQL driver hands JSON
 * columns back as strings; a row written before the column existed is NULL.
 * Anything that is not a JSON array of strings is treated as a restriction to
 * nothing (an empty list), never as "unrestricted", so corrupt data fails
 * closed.
 */
export function parseStoredWaveAllowlist(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let decoded: unknown = raw;
  if (typeof raw === 'string') {
    try {
      decoded = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (decoded === null) {
    return null;
  }
  if (!Array.isArray(decoded)) {
    return [];
  }
  return decoded.filter(isNonEmptyString);
}

export function serializeWaveAllowlist(
  allowlist: ProxyWaveAllowlist | undefined
): string | null {
  return allowlist ? JSON.stringify(allowlist) : null;
}

/** `null` allows every wave; a list allows exactly its members. */
export function isWaveAllowedByAllowlist(
  allowlist: ProxyWaveAllowlist | undefined,
  waveId: string
): boolean {
  if (allowlist === null || allowlist === undefined) {
    return true;
  }
  return allowlist.includes(waveId);
}
