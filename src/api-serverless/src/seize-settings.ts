import { env } from '@/env';
import type { ApiAuthSettings } from '@/api/generated/models/ApiAuthSettings';
import type { ApiSeizeSettings } from '@/api/generated/models/ApiSeizeSettings';

function normalizeWalletList(wallets: string[]): string[] {
  return wallets.map((wallet) => wallet.trim()).filter(Boolean);
}

export function getDistributionAdminWallets(): string[] {
  return normalizeWalletList(
    env.getStringArray('DISTRIBUTION_ADMIN_WALLETS', ',')
  );
}

export function getClaimsAdminWallets(): string[] {
  return normalizeWalletList(env.getStringArray('CLAIMS_ADMIN_WALLETS', ','));
}

function isIsoDateTimeWithTimezone(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  );
}

function getSessionV2MigrationDeadline(): string | null {
  const deadline = env.getStringOrNull('SESSION_V2_MIGRATION_DEADLINE');
  if (!deadline) {
    return null;
  }
  if (!isIsoDateTimeWithTimezone(deadline)) {
    throw new Error(
      'SESSION_V2_MIGRATION_DEADLINE must be an ISO datetime with timezone'
    );
  }
  return deadline;
}

function authSettings(): ApiAuthSettings {
  return {
    structured_signatures_required:
      process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED === 'true',
    session_v2_migration_deadline: getSessionV2MigrationDeadline()
  };
}

export const seizeSettings = (): ApiSeizeSettings => {
  const rememes_submission_tdh_threshold =
    env.getIntOrNull('REMEMED_SUBMISSION_TDH_THRESHOLD') ?? 6942;
  const all_drops_notifications_subscribers_limit =
    env.getIntOrNull('ALL_DROPS_NOTIFICATIONS_SUBSCRIBERS_LIMIT') ?? 15;

  const memes_wave_id = env.getStringOrNull('MAIN_STAGE_WAVE_ID');
  const curation_wave_id = env.getStringOrNull('CURATION_WAVE_ID');
  const announcements_wave_id = env.getStringOrNull('ANNOUNCEMENTS_WAVE_ID');
  const quorum_wave_id = env.getStringOrNull('QUORUM_WAVE_ID');
  const distribution_admin_wallets = getDistributionAdminWallets();
  const claims_admin_wallets = getClaimsAdminWallets();

  return {
    rememes_submission_tdh_threshold,
    all_drops_notifications_subscribers_limit,
    memes_wave_id,
    curation_wave_id,
    distribution_admin_wallets,
    claims_admin_wallets,
    announcements_wave_id,
    quorum_wave_id,
    auth: authSettings()
  };
};
