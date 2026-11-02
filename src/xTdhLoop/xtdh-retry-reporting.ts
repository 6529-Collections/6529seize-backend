import type { LambdaSentryEvent } from '@/sentry.context';
import { XTdhIdentitySnapshotChangedError } from '@/xtdh/xtdh-identity-snapshot-changed-error';

// Keep aligned with XTdhStartQueue.RedrivePolicy.maxReceiveCount.
export const XTDH_FINAL_ATTEMPT = 5;

export function getXTdhReceiveCount(event: unknown): number | undefined {
  if (
    !isRecord(event) ||
    !Array.isArray(event.Records) ||
    event.Records.length !== 1
  ) {
    return undefined;
  }
  const record = event.Records[0];
  if (!isRecord(record) || !isRecord(record.attributes)) return undefined;
  const value = record.attributes.ApproximateReceiveCount;
  if (typeof value !== 'string') return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 && String(count) === value
    ? count
    : undefined;
}

export function shouldCaptureXTdhError(error: unknown): boolean {
  if (!(error instanceof XTdhIdentitySnapshotChangedError)) return true;
  const count = error.receiveCount;
  return !(
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    count < XTDH_FINAL_ATTEMPT
  );
}

export function enrichXTdhSentryEvent(
  event: LambdaSentryEvent,
  error: unknown
): LambdaSentryEvent {
  if (!(error instanceof XTdhIdentitySnapshotChangedError)) return event;
  return {
    ...event,
    extra: {
      ...event.extra,
      xtdh_receive_count: error.receiveCount ?? 'unknown',
      xtdh_final_attempt: XTDH_FINAL_ATTEMPT
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
