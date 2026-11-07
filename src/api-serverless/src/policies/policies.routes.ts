import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { getTelemetryViewer } from '@/api/telemetry/telemetry-edge';
import { getIp, isEUCountry, isLocalhost } from './policies';
import { deleteCookiesConsent, saveCookiesConsent } from './policies.db';

const router = asyncRouter();

export default router;

/**
 * Legacy country lookup. The country now comes only from CloudFront's
 * `CloudFront-Viewer-Country` on requests that carry the 6529.io edge secret
 * (see telemetry-edge.ts); no third-party IP lookup is made. Clients should
 * use `GET /e/country` on 6529.io. A direct API call cannot be located, so it
 * gets the same 400 a failed lookup always returned: the frontend then keeps
 * the country unknown, which keeps iOS purchasing restricted (fail closed).
 */
router.get(`/country-check`, function (req: Request, res: any) {
  const ip: string = getIp(req);
  if (ip && isLocalhost(ip)) {
    return res.status(200).send({
      is_eu: true,
      country: null
    });
  }

  const { country } = getTelemetryViewer(req);
  if (!country) {
    return res.status(400).send({
      message: 'Failed to get country'
    });
  }
  return res.status(200).send({
    is_eu: isEUCountry(country),
    country
  });
});

router.post(`/cookies-consent`, function (req: Request, res: any) {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  saveCookiesConsent(ip).then(() => {
    return res.status(200).send({
      message: 'Cookies consent saved'
    });
  });
});

router.delete(`/cookies-consent`, function (req: Request, res: any) {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  deleteCookiesConsent(ip).then(() => {
    return res.status(200).send({
      message: 'Cookies consent deleted'
    });
  });
});
