import { DbQueryOptions } from '@/db-query.options';
import { makeChoice } from './identity-choices';

/**
 * Turns automatic mode on for an identity, as the legacy
 * updateSubscriptionMode does on a first top-up that covers a card: the
 * mode row (its time moves only if it was manual), the "Subscription Mode
 * set to Automatic" line, every upcoming card the identity had unsubscribed
 * from subscribed again with a "Subscribed to Meme #N" line, and, with all
 * editions on, the automatic rows' counts set to the eligibility. It is the
 * subs.mode change without the balance check, which the top-up made.
 * `atText` is the time written (a top-up's transaction time, so a rebuild
 * writes the same). Runs in the caller's transaction; returns the ids of
 * the log lines it wrote, for the journal.
 */
export async function turnIdentityAutomaticOn(params: {
  readonly identityKey: string;
  /** The identity's consolidation key: what eligibility and log rows use. */
  readonly consolidationKey: string;
  readonly atText: string;
  readonly options: DbQueryOptions;
}): Promise<number[]> {
  const made = await makeChoice(
    { ...params, rules: false },
    { type: 'subs.mode', automatic: true }
  );
  return made.logIds;
}
