export interface SentryAlertWaveFollowerRecipient {
  readonly identity_id: string;
  readonly subscribed_to_all_drops: boolean;
}

export function selectSentryAlertAllDropsSubscriberIds(
  recipients: readonly SentryAlertWaveFollowerRecipient[]
): string[] {
  return recipients
    .filter((recipient) => recipient.subscribed_to_all_drops)
    .map((recipient) => recipient.identity_id);
}
