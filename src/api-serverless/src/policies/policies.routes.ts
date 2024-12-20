import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { getIp, getIpInfo, isEUCountry, isLocalhost } from './policies';
import {
  deleteCookiesConsent,
  saveCookiesConsent,
  deleteEULAConsent,
  saveEULAConsent,
  fetchEULAConsent
} from './policies.db';

const router = asyncRouter();

export default router;

router.get(`/country-check`, function (req: Request, res: any) {
  const ip: string = getIp(req);

  if (!ip) {
    return res.status(400).send({
      message: 'Failed to get IP address'
    });
  }

  if (isLocalhost(ip)) {
    return res.status(200).send({
      is_eu: true
    });
  }

  getIpInfo(ip).then(async (ipInfo) => {
    if (!ipInfo?.country) {
      return res.status(400).send({
        message: 'Failed to get country from IP address'
      });
    }
    return res.status(200).send({
      is_eu: isEUCountry(ipInfo.country)
    });
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

router.post(`/eula-consent`, function (req: Request, res: any) {
  const deviceId = req.body.device_id;
  const platform = req.body.platform;
  if (!deviceId || !platform) {
    return res.status(400).send({
      message: 'EULA consent: Failed to get device id or platform'
    });
  }

  saveEULAConsent(deviceId, platform).then(() => {
    return res.status(200).send({
      message: 'EULA consent saved'
    });
  });
});

router.delete(`/eula-consent`, function (req: Request, res: any) {
  const deviceId = req.body.device_id;

  if (!deviceId) {
    return res.status(400).send({
      message: 'EULA consent: Failed to get device id'
    });
  }

  deleteEULAConsent(deviceId).then(() => {
    return res.status(200).send({
      message: 'EULA consent deleted'
    });
  });
});

router.get(`/eula-consent/:deviceId`, function (req: Request, res: any) {
  const deviceId = req.params.deviceId;
  fetchEULAConsent(deviceId).then((consent) => {
    return res.status(200).send(consent ?? {});
  });
});
