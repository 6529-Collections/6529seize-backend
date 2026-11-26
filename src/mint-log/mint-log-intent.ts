import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import type { MintVerifiedRecord } from './mint-log-ports';
import type { MintLogKind } from './mint-log.types';

/**
 * An admin's intent: the route, its path parameters as sent, and the JSON
 * body (null for a GET). The admin signs a kind 9 RECORD of type `mint.admin`
 * in their own `ps` stream whose body names the action and the sha256 of the
 * intent's canonical JSON, so the record stays small whatever the request.
 */
export const MINT_ADMIN_RECORD_TYPE = 'mint.admin';
/** The same record for a user's own write, such as a collaboration reply. */
export const MINT_USER_RECORD_TYPE = 'mint.user';

export interface MintIntent {
  /** Method and route pattern, for example `POST /distributions/:contract/:id/normalize`. */
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface MintAdminRecordBody {
  readonly action: MintLogKind;
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly request_sha256: string;
}

export function intentSha256(intent: MintIntent): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        body: intent.body ?? null,
        params: intent.params,
        route: intent.route
      })
    )
    .digest('hex');
}

export function adminRecordBody(
  action: MintLogKind,
  intent: MintIntent
): MintAdminRecordBody {
  return {
    action,
    route: intent.route,
    params: intent.params,
    request_sha256: intentSha256(intent)
  };
}

/**
 * Why a verified record does not authorize this write, or null when it does:
 * it must be a record of the given type by the authenticated wallet for this
 * exact action and request.
 */
export function recordMismatch(
  record: MintVerifiedRecord,
  action: MintLogKind,
  intent: MintIntent,
  wallet: string | null,
  type: string = MINT_ADMIN_RECORD_TYPE
): string | null {
  if (record.refs[0] !== type || record.refs.length !== 2) {
    return `refs must be ["${type}", key]`;
  }
  if (!wallet || record.author !== wallet.toLowerCase()) {
    return 'the record author is not the signed-in wallet';
  }
  if (!record.body) {
    return 'the record has no body';
  }
  const expected = adminRecordBody(action, intent);
  if (canonicalizeJson(record.body) !== canonicalizeJson(expected)) {
    return `the record body does not match this ${action} request`;
  }
  return null;
}
