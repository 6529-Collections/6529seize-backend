import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum
} from '@aws-sdk/client-cloudwatch';
import { Logger } from '@/logging';

const logger = Logger.get('RELEASE_BUS_METRICS');
const client = new CloudWatchClient({});

export async function publishReleaseBusMetrics(
  metrics: readonly MetricDatum[]
): Promise<void> {
  if (metrics.length === 0 || process.env.NODE_ENV === 'test') return;
  try {
    await client.send(
      new PutMetricDataCommand({
        Namespace: '6529/ReleaseBus',
        MetricData: metrics.map((metric) => ({
          Unit: 'Count',
          Timestamp: new Date(),
          ...metric
        }))
      })
    );
  } catch (error) {
    logger.warn(
      `Failed to publish release-bus metrics: ${
        error instanceof Error ? error.message : 'unknown CloudWatch error'
      }`
    );
  }
}
