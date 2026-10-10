export interface UpcomingSubscriptionState {
  readonly subscribed: boolean;
  readonly automatic_subscription: boolean;
  readonly subscribed_count: number;
  readonly updated_at: Date;
}

/**
 * Combines two upcoming-card subscription rows when two consolidations merge
 * and both already had a row for the same card.
 *
 * - The merged consolidation is subscribed if either was.
 * - The count is the larger of the subscribed rows' counts. Eligibility (full
 *   Meme sets) only grows when wallets merge, so this never exceeds it;
 *   automatic rows are re-synced to eligibility afterwards anyway.
 * - A manual choice wins over an automatic one.
 * - The earlier priority timestamp of the subscribed rows is kept.
 *
 * When neither row is subscribed the surviving row is left as it was.
 */
export function mergeUpcomingSubscriptions(
  surviving: UpcomingSubscriptionState,
  merged: UpcomingSubscriptionState
): UpcomingSubscriptionState {
  const subscribedRows = [surviving, merged].filter((row) => row.subscribed);
  if (subscribedRows.length === 0) {
    return surviving;
  }
  return {
    subscribed: true,
    automatic_subscription: subscribedRows.every(
      (row) => row.automatic_subscription
    ),
    subscribed_count: Math.max(
      ...subscribedRows.map((row) => row.subscribed_count)
    ),
    updated_at: new Date(
      Math.min(...subscribedRows.map((row) => row.updated_at.getTime()))
    )
  };
}
