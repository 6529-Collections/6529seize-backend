import {
  GetMonitoringAccessRequest,
  GetMonitoringSentryRequest,
  GetMonitoringSentryHistoryRequest
} from '@/api/generated/routes/operations';
import { ApiMonitoringAccess } from '@/api/generated/models/ApiMonitoringAccess';
import { ApiMonitoringSentryOverview } from '@/api/generated/models/ApiMonitoringSentryOverview';
import { ApiMonitoringSentryHistory } from '@/api/generated/models/ApiMonitoringSentryHistory';
import { CustomApiCompliantException } from '@/exceptions';
import { getSentryOverview } from './sentry-overview';
import { getSentryHistory } from './sentry-history';

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

export async function handleGetMonitoringSentryHistory(
  _req: GetMonitoringSentryHistoryRequest
): Promise<ApiMonitoringSentryHistory> {
  try {
    return await getSentryHistory();
  } catch {
    throw new CustomApiCompliantException(
      503,
      'Sentry history is temporarily unavailable',
      'MONITORING_SENTRY_HISTORY_UNAVAILABLE'
    );
  }
}
