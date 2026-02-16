import { env } from '@/env';
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

export const seizeSettings = (): ApiSeizeSettings => {
  const rememes_submission_tdh_threshold =
    env.getIntOrNull('REMEMED_SUBMISSION_TDH_THRESHOLD') ?? 6942;
  const all_drops_notifications_subscribers_limit =
    env.getIntOrNull('ALL_DROPS_NOTIFICATIONS_SUBSCRIBERS_LIMIT') ?? 15;

  const memes_wave_id = env.getStringOrNull('MAIN_STAGE_WAVE_ID');
  const distribution_admin_wallets = getDistributionAdminWallets();
  const claims_admin_wallets = getClaimsAdminWallets();
  const meme_claims = {
    contract: env.getStringOrNull('MEME_CLAIMS_CONTRACT'),
    network_id: env.getIntOrNull('MEME_CLAIMS_NETWORK_ID')
  };

  return {
    rememes_submission_tdh_threshold,
    all_drops_notifications_subscribers_limit,
    memes_wave_id,
    distribution_admin_wallets,
    claims_admin_wallets,
    meme_claims
  };
};
