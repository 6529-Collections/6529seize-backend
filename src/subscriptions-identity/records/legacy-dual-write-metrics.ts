import { Logger } from '@/logging';
import type { SubscriptionRecordType } from './subscription-records';

// After the identity switch, a person's change goes to the identity tables
// and then to the legacy tables, the rollback copy. For a key the key-width
// guard holds back, the legacy write is refused, as it was before the
// switch. Each such refusal is one count, by change type, as an EMF line on
// stdout (no CloudWatch API call or IAM change), the way
// legacy-auth-metrics.ts counts. The day's sum is the day's count. Never
// records keys, wallets or principals.

const NAMESPACE = '6529/Subscriptions';
const logger = Logger.get('SUBSCRIPTIONS_LEGACY_DUAL_WRITE_METRICS');

export function recordLegacyDualWriteHeldBack(
  changeType: SubscriptionRecordType
): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.subscriptions_legacy_dual_write_held_back.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [['ChangeType']],
              Metrics: [{ Name: 'LegacyDualWriteHeldBack', Unit: 'Count' }]
            }
          ]
        },
        ChangeType: changeType,
        LegacyDualWriteHeldBack: 1
      })}\n`
    );
  } catch {
    // A count must never change a request, not even through the logger
    // when stdout itself is failing.
    try {
      logger.error('Legacy dual write held-back count could not be emitted');
    } catch {
      // Nothing left to report to.
    }
  }
}
