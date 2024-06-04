import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { getIp, getIpInfo, isEUCountry, isLocalhost } from './policies';
import { deleteCookiesConsent, saveCookiesConsent } from './policies.db';

const router = asyncRouter();

export default router;

router.get(`/country-check`, function (req: Request, res: any) {
  let ip: string = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  getIpInfo(ip).then(async (ipInfo) => {
    const isEU = isEUCountry(ipInfo?.country) || isLocalhost(ip);
    return res.status(200).send({
      is_eu: isEU
    });
  });
});

router.post(`/cookies-consent`, function (req: Request, res: any) {
  let ip = getIp(req);

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
  let ip = getIp(req);

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
