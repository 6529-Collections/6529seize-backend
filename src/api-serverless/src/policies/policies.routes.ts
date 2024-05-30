import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { getIp, getIpInfo, isEUCountry, isLocalhost } from './policies';
import { isCookiesConsent, setCookiesConsent } from './policies.db';

const router = asyncRouter();

export default router;

router.get(`/cookies_consent`, function (req: Request, res: any) {
  let ip: string = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  getIpInfo(ip).then(async (ipInfo) => {
    const isEU = isEUCountry(ipInfo?.country) || isLocalhost(ip);

    const isConsent = await isCookiesConsent(ip);

    return res.status(200).send({
      is_eu: isEU,
      is_consent: isConsent
    });
  });
});

router.post(`/cookies_consent`, function (req: Request, res: any) {
  let ip = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  setCookiesConsent(ip).then(() => {
    return res.status(200).send({
      message: 'Cookies consent saved'
    });
  });
});
