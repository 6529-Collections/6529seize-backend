import type { SubscriptionCoverageNotificationData } from '@/notifications/user-notification.types';

export function buildSubscriptionCoveragePushNotificationData(
  additionalData: SubscriptionCoverageNotificationData,
  handle: string
) {
  if (
    additionalData.status !== 'RUNNING_LOW' &&
    additionalData.status !== 'ACTION_REQUIRED'
  ) {
    return null;
  }

  const nextUnfunded = additionalData.next_unfunded;
  const nextDropLabel = nextUnfunded
    ? `Meme #${nextUnfunded.token_id}`
    : 'Your next intended Meme';
  const topUpMessage = additionalData.minimum_top_up_eth
    ? ` Top up ${additionalData.minimum_top_up_eth} ETH to fully fund it.`
    : '';
  const isActionRequired = additionalData.status === 'ACTION_REQUIRED';
  const title = isActionRequired
    ? 'Subscription top-up required'
    : 'Subscription balance is running low';
  const body = isActionRequired
    ? `${nextDropLabel} is not fully funded.${topUpMessage}`
    : `Your balance fully funds ${additionalData.fully_funded_drops} intended drops.`;

  return {
    title,
    body,
    data: {
      redirect: 'profile',
      handle,
      subroute: 'subscriptions'
    },
    imageUrl: null
  };
}
