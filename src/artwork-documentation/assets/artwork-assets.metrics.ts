import {
  CloudWatchClient,
  PutMetricDataCommand
} from '@aws-sdk/client-cloudwatch';
import { artworkAssetsDb } from '@/artwork-documentation/assets/artwork-assets.db';
import { artworkArchiveRegion } from '@/artwork-documentation/assets/artwork-assets.config';

let client: CloudWatchClient;
export async function publishArtworkAssetMetrics(): Promise<void> {
  client ??= new CloudWatchClient({ region: artworkArchiveRegion() });
  const stats = await artworkAssetsDb.operationalStats(Date.now());
  await client.send(
    new PutMetricDataCommand({
      Namespace: '6529/ArtworkDocumentation',
      MetricData: [
        { MetricName: 'PendingAssets', Value: stats.pending, Unit: 'Count' },
        {
          MetricName: 'OldestPendingAge',
          Value: stats.oldestAgeSeconds,
          Unit: 'Seconds'
        },
        {
          MetricName: 'FailuresLastHour',
          Value: stats.failuresLastHour,
          Unit: 'Count'
        },
        {
          MetricName: 'MaximumContextQuotaUsage',
          Value: stats.maxQuotaPercent,
          Unit: 'Percent'
        }
      ]
    })
  );
}
