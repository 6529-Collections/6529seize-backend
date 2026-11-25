import { NextFunction, Request } from 'express';
import { asyncRouter } from '../async.router';
import {
  getIp,
  getIpInfo,
  getWafCountry,
  isEUCountry,
  isLocalhost
} from './policies';
import { deleteCookiesConsent, saveCookiesConsent } from './policies.db';
import { personalRecordsMode } from '@/personal-records/personal-records.mode';

const router = asyncRouter();

export default router;

router.get(`/country-check`, async function (req: Request, res: any) {
  const ip: string = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  if (isLocalhost(ip)) {
    return res.status(200).send({
      is_eu: true,
      country: null
    });
  }

  const country = getWafCountry(req) ?? (await getIpInfo(ip))?.country;
  if (!country) {
    return res.status(400).send({
      message: 'Failed to get country from IP address'
    });
  }
  return res.status(200).send({
    is_eu: isEUCountry(country),
    country
  });
});

router.post(
  `/cookies-consent`,
  function (req: Request, res: any, next: NextFunction) {
    const ip = getIp(req);

    if (!ip) {
      return res.status(400).send({
        message: 'Failed to get IP address'
      });
    }

    // In primary mode the browser's cookie is the record; nothing is stored.
    const stored =
      personalRecordsMode() === 'primary'
        ? Promise.resolve()
        : saveCookiesConsent(ip);
    stored
      .then(() =>
        res.status(200).send({
          message: 'Cookies consent saved'
        })
      )
      .catch(next);
  }
);

router.delete(
  `/cookies-consent`,
  function (req: Request, res: any, next: NextFunction) {
    const ip = getIp(req);

    if (!ip) {
      return res.status(400).send({
        message: 'Failed to get IP address'
      });
    }

    const removed =
      personalRecordsMode() === 'primary'
        ? Promise.resolve()
        : deleteCookiesConsent(ip);
    removed
      .then(() =>
        res.status(200).send({
          message: 'Cookies consent deleted'
        })
      )
      .catch(next);
  }
);
