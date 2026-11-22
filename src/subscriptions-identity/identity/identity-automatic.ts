import { getSubscriptionCutoffMemeId } from '@/api/subscriptions/subscription-cutoff';
import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { sqlExecutor } from '@/sql-executor';
import { fetchSubscriptionEligibilityForKeys } from '@/subscriptionsDaily/db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from '@/subscriptionsDaily/subscription-eligibility';
import { flag } from '../opening/legacy-tables';

/**
 * Turns automatic mode on for an identity, as the legacy
 * updateSubscriptionMode does on a first top-up that covers a card: the
 * mode row (its time moves only if it was manual), the "Subscription Mode
 * set to Automatic" line, every upcoming card the identity had unsubscribed
 * from subscribed again with a "Subscribed to Meme #N" line, and, with all
 * editions on, the automatic rows' counts set to the eligibility. `atText`
 * is the time written (a top-up's transaction time, so a rebuild writes the
 * same). Runs in the caller's transaction.
 */
export async function turnIdentityAutomaticOn(params: {
  readonly identityKey: string;
  /** The identity's consolidation key: what eligibility and log rows use. */
  readonly consolidationKey: string;
  readonly atText: string;
  readonly options: DbQueryOptions;
}): Promise<void> {
  const { identityKey, consolidationKey, atText, options } = params;
  const q = <T>(sql: string, p: Record<string, unknown>) =>
    sqlExecutor.execute<T>(sql, p, options);
  const log = (text: string) =>
    q(
      `INSERT INTO ${SUBSCRIPTIONS_ID_LOGS_TABLE}
        (identity_key, consolidation_key, log, created_at)
        VALUES (:identityKey, :key, :log, :atText)`,
      { identityKey, key: consolidationKey, log: text, atText }
    );
  await q(
    `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE} (identity_key, automatic, created_at, updated_at)
      VALUES (:identityKey, true, :atText, :atText)
      ON DUPLICATE KEY UPDATE
        updated_at = IF(automatic, updated_at, VALUES(updated_at)),
        automatic = true`,
    { identityKey, atText }
  );
  await log('Subscription Mode set to Automatic');

  const cutoff = await getSubscriptionCutoffMemeId(options);
  const unsubscribed = await q<{ token_id: number }>(
    `SELECT token_id FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE}
      WHERE identity_key = :identityKey AND contract = :contract
        AND token_id > :cutoff AND subscribed = false`,
    { identityKey, contract: MEMES_CONTRACT, cutoff }
  );
  for (const row of unsubscribed) {
    await q(
      `UPDATE ${SUBSCRIPTIONS_ID_NFTS_TABLE} SET subscribed = true, updated_at = :atText
        WHERE identity_key = :identityKey AND contract = :contract AND token_id = :tokenId`,
      {
        identityKey,
        contract: MEMES_CONTRACT,
        tokenId: row.token_id,
        atText
      }
    );
    await log(`Subscribed to Meme #${row.token_id}`);
  }

  const [mode] = await q<{ subscribe_all_editions: number }>(
    `SELECT subscribe_all_editions FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE identity_key = :identityKey`,
    { identityKey }
  );
  if (!mode || !flag(mode.subscribe_all_editions)) {
    return;
  }
  const eligibility =
    (
      await fetchSubscriptionEligibilityForKeys([consolidationKey], options)
    ).get(consolidationKey.toLowerCase()) ?? MINIMUM_SUBSCRIPTION_ELIGIBILITY;
  await q(
    `UPDATE ${SUBSCRIPTIONS_ID_NFTS_TABLE}
        SET subscribed_count = :eligibility, updated_at = updated_at
      WHERE identity_key = :identityKey AND contract = :contract
        AND token_id > :maxMemeId AND subscribed = true AND automatic_subscription = true`,
    {
      identityKey,
      contract: MEMES_CONTRACT,
      maxMemeId: await getMaxMemeId(true, options),
      eligibility
    }
  );
}
