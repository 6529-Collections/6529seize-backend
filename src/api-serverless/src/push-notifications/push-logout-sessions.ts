import { WALLET_AUTH_SESSIONS_TABLE } from '@/constants';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { hashSecret } from '@/api/auth/auth-session-v2';
import type { InstallationRevocation } from './push-installation.db';

type Sessions = InstallationRevocation['sessions'];

/** This proof permits a credential-scoped fence; it does not prove device ownership. */
export async function requireLiveNativeSession(
  sessions: Sessions,
  ctx: RequestContext
): Promise<void> {
  for (const session of sessions) {
    const authenticated = await sqlExecutor.oneOrNull<{ id: string }>(
      `SELECT id FROM ${WALLET_AUTH_SESSIONS_TABLE}
       WHERE LOWER(address) = :address AND refresh_token_hash = :hash
       AND client_type = 'native' AND revoked_at IS NULL AND expires_at > :now
       LIMIT 1`,
      {
        address: session.address.toLowerCase(),
        hash: hashSecret(session.native_refresh_token),
        now: new Date()
      },
      { wrappedConnection: ctx.connection }
    );
    if (authenticated) return;
  }
  throw new ForbiddenException(
    'A native session is required for logout before push registration'
  );
}

export async function revokeNativeSessions(
  sessions: Sessions,
  ctx: RequestContext
): Promise<void> {
  // Different installations can supply overlapping sessions. Lock those rows in
  // the same order; auth refresh/revocation never subsequently locks push tables.
  const ordered = sessions
    .map((session) => ({
      address: session.address.toLowerCase(),
      hash: hashSecret(session.native_refresh_token)
    }))
    .sort(
      (left, right) =>
        left.hash.localeCompare(right.hash) ||
        left.address.localeCompare(right.address)
    );
  for (const session of ordered) {
    await sqlExecutor.execute(
      `UPDATE ${WALLET_AUTH_SESSIONS_TABLE} SET revoked_at = COALESCE(revoked_at, :now)
       WHERE LOWER(address) = :address AND refresh_token_hash = :hash AND client_type = 'native'`,
      { ...session, now: new Date() },
      { wrappedConnection: ctx.connection }
    );
  }
}
