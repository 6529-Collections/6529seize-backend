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
 * - Subscribed manual requests determine the quantity when present; keep the
 *   larger manual request if several conflict. Otherwise keep the larger
 *   automatic quantity, which can be re-synced to eligibility afterwards.
 * - A manual choice wins over an automatic one. Only subscribed rows count,
 *   so the mode of an unsubscribed row is discarded.
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
  const manualRows = subscribedRows.filter(
    (row) => !row.automatic_subscription
  );
  const quantityRows = manualRows.length > 0 ? manualRows : subscribedRows;
  return {
    subscribed: true,
    automatic_subscription: subscribedRows.every(
      (row) => row.automatic_subscription
    ),
    subscribed_count: Math.max(
      ...quantityRows.map((row) => row.subscribed_count)
    ),
    updated_at: new Date(
      Math.min(...subscribedRows.map((row) => row.updated_at.getTime()))
    )
  };
}
