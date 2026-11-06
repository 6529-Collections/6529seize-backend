import { Request } from 'express';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { env } from '@/env';
import { ForbiddenException } from '@/exceptions';
import { equalIgnoreCase } from '@/strings';

/**
 * Team-only telemetry reads (diagnostics bundles, internal dashboards) need a
 * signed-in wallet listed in `TELEMETRY_TEAM_WALLETS` (comma separated).
 * With no list configured, nobody has access.
 */
export function getTelemetryTeamWallets(): string[] {
  return env
    .getStringArray('TELEMETRY_TEAM_WALLETS', ',')
    .map((wallet) => wallet.trim())
    .filter(Boolean);
}

export function assertTelemetryTeamMember(
  req: Request<any, any, any, any, any>
): string {
  const wallet = getAuthenticatedWalletOrNull(req);
  if (
    !wallet ||
    !getTelemetryTeamWallets().some((teamWallet) =>
      equalIgnoreCase(teamWallet, wallet)
    )
  ) {
    throw new ForbiddenException('Telemetry data is team-only');
  }
  return wallet;
}
