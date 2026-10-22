import type { CreditReturnDeliveryStats } from './voting-credit-returns.db';

/** EMF uses an unprefixed JSON log line; no CloudWatch API call or IAM change. */
export function recordVotingCreditReturnMetrics(
  stats: CreditReturnDeliveryStats
): void {
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'VotingCreditReturns',
            Dimensions: [[]],
            Metrics: [
              { Name: 'PendingReleases', Unit: 'Count' },
              { Name: 'DeadLetterReleases', Unit: 'Count' }
            ]
          }
        ]
      },
      PendingReleases: stats.pending_releases,
      DeadLetterReleases: stats.failed_releases
    })}\n`
  );
}
