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
import { journalPosting } from '../timeline/journal';
import { sendSubscriptionWaveNotifications } from '@/transactionsProcessingLoop/subscriptions';

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

/**
 * Runs a legacy loop step (the legacy redemption run, the top-up discovery
 * and legacy credit). Once the identity tables are the truth, the legacy
 * tables are the rollback copy: a failure there alerts and the identity
 * writer after it still runs. Before that a failure fails the run, as it
 * always has.
 */
export async function runLegacySubscriptionStep(
  name: string,
  step: () => Promise<unknown>
): Promise<void> {
  if ((await subscriptionsIdentitySwitch.writeModeForLegacy()) !== 'TRUTH') {
    await step();
    return;
  }
  try {
    await step();
  } catch (error) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_LEGACY_DUAL_WRITE_FAILED',
      `[LEGACY ${name} FAILED] the identity tables are the truth and go on; the legacy copy lags`,
      error
    );
  }
}

/** Alerts when journal entries wait unposted (they'd be lost with the database). */
async function checkJournalPosting(): Promise<void> {
  const posting = await journalPosting();
  if (!posting.ok) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_JOURNAL_STALE',
      `[JOURNAL NOT POSTED] ${posting.reason}`
    );
  }
}

/** The top-up loop's identity writers: bound wallets fold in, then top-ups. */
export function runIdentityTopUpWriters(): Promise<void> {
  return runIdentityWriter('TOP-UPS', async () => {
    await checkJournalPosting();
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
      // After the switch the warnings come from the truth (the legacy
      // loop only logs its own); in shadow the legacy loop posts them.
      if (mode === 'TRUTH') {
        await sendSubscriptionWaveNotifications(run.notices, 'IDENTITY');
      }
      await reportRedemptionComparison(mode, run);
    }
  });
}
