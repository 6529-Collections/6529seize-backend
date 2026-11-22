import { Logger } from '@/logging';
import {
  IdentityWriteMode,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import { foldBoundWallets } from './identity-fold';
import {
  redeemIdentityAirdrops,
  reportRedemptionComparison
} from './identity-redemptions';
import { creditIdentityTopUps } from './identity-top-ups';

const logger = Logger.get('SUBSCRIPTIONS_IDENTITY_WRITERS');

/**
 * Runs an identity writer, after the legacy loop's own work, when the
 * identity tables are kept up to date. In shadow a failure (including not
 * being able to read the mode) is logged and never stops the legacy loop;
 * once the identity tables are the truth it fails the run.
 */
async function runIdentityWriter(
  name: string,
  write: (mode: IdentityWriteMode) => Promise<void>
): Promise<void> {
  const mode = await subscriptionsIdentitySwitch.writeModeForLegacy();
  if (mode === 'OFF') {
    return;
  }
  try {
    await write(mode);
  } catch (error) {
    if (mode === 'TRUTH') {
      throw error;
    }
    logger.error(`[SHADOW ${name} FAILED]`, error);
  }
}

/** The top-up loop's identity writers: bound wallets fold in, then top-ups. */
export function runIdentityTopUpWriters(): Promise<void> {
  return runIdentityWriter('TOP-UPS', async () => {
    const folded = await foldBoundWallets();
    const credited = await creditIdentityTopUps();
    if (folded || credited) {
      logger.info(
        `[IDENTITY TABLES] folded ${folded} bound wallets, credited ${credited} top-ups`
      );
    }
  });
}

/** The transactions loop's identity writer: airdrops charged, then compared. */
export function runIdentityRedemptionWriters(): Promise<void> {
  return runIdentityWriter('REDEMPTIONS', async (mode) => {
    const run = await redeemIdentityAirdrops();
    if (run) {
      await reportRedemptionComparison(mode, run);
    }
  });
}
