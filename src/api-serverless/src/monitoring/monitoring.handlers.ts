import {
  GetMonitoringAccessRequest,
  GetMonitoringSentryRequest
} from '@/api/generated/routes/operations';
import { ApiMonitoringAccess } from '@/api/generated/models/ApiMonitoringAccess';
import { ApiMonitoringSentryOverview } from '@/api/generated/models/ApiMonitoringSentryOverview';
import { CustomApiCompliantException } from '@/exceptions';
import { getSentryOverview } from './sentry-overview';

export function handleGetMonitoringAccess(
  _req: GetMonitoringAccessRequest
): Promise<ApiMonitoringAccess> {
  return Promise.resolve({ access: true });
}

export async function handleGetMonitoringSentry(
  _req: GetMonitoringSentryRequest
): Promise<ApiMonitoringSentryOverview> {
  try {
    return await getSentryOverview();
  } catch {
    throw new CustomApiCompliantException(
      503,
      'Sentry monitoring is temporarily unavailable',
      'MONITORING_SENTRY_UNAVAILABLE'
    );
  }
}
