import express, { Request, Response } from 'express';
import { ApiTelemetryCountry } from '@/api/generated/models/ApiTelemetryCountry';
import { isEUCountry } from '@/api/policies/policies';
import { getTelemetryViewer } from '@/api/telemetry/telemetry-edge';

/**
 * `GET /api/e/country` (6529.io/e/country): the viewer's country from
 * CloudFront's `CloudFront-Viewer-Country`, replacing the findip.net lookup.
 * It only trusts the header on requests that carry the edge secret, so a
 * direct API call can never claim a country. Unknown is answered as
 * `{ country: null, is_eu: true }`: the cookie banner shows, and the iOS
 * US-only purchasing rule stays restricted (fail closed). Nothing is stored
 * or logged.
 */
export function getTelemetryCountry(req: Request): ApiTelemetryCountry {
  const { country } = getTelemetryViewer(req);
  if (!country) {
    return { country: null, is_eu: true };
  }
  return { country, is_eu: isEUCountry(country) };
}

const router = express.Router();

router.get('/', (req: Request, res: Response<ApiTelemetryCountry>) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json(getTelemetryCountry(req));
});

export default router;
