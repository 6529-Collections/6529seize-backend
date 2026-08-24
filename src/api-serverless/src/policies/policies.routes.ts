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
import { CURRENT_EULA_VERSION } from './eula-policy';

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
      is_eu: true,
      country: null
    });
  }

  getIpInfo(ip).then(async (ipInfo) => {
    if (!ipInfo?.country) {
      return res.status(400).send({
        message: 'Failed to get country from IP address'
      });
    }
    return res.status(200).send({
      is_eu: isEUCountry(ipInfo.country),
      country: ipInfo.country
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

type EULAConsentRequest = {
  readonly deviceId: string;
  readonly platform: string;
  readonly eulaVersion: string;
};

type EULAConsentRequestValidation =
  | { readonly ok: true; readonly value: EULAConsentRequest }
  | { readonly ok: false };

const getBoundedString = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
};

export const validateEULAConsentRequest = (
  body: unknown
): EULAConsentRequestValidation => {
  if (!body || typeof body !== 'object') {
    return { ok: false };
  }

  const requestBody = body as Record<string, unknown>;
  const deviceId = getBoundedString(requestBody['device_id'], 100);
  const platform = getBoundedString(requestBody['platform'], 32);
  const eulaVersion = getBoundedString(requestBody['eula_version'], 32);
  if (!deviceId || platform !== 'ios' || eulaVersion !== CURRENT_EULA_VERSION) {
    return { ok: false };
  }

  return {
    ok: true,
    value: { deviceId, platform, eulaVersion }
  };
};

router.post(`/eula-consent`, async function (req: Request, res: any) {
  const validation = validateEULAConsentRequest(req.body);
  if (!validation.ok) {
    return res.status(400).send({
      message: 'EULA consent: Invalid device id, platform, or EULA version'
    });
  }

  const { deviceId, platform, eulaVersion } = validation.value;
  await saveEULAConsent(deviceId, platform, eulaVersion);
  return res.status(200).send({
    message: 'EULA consent saved',
    eula_version: eulaVersion
  });
});

router.delete(`/eula-consent`, async function (req: Request, res: any) {
  const deviceId = getBoundedString(req.body?.device_id, 100);

  if (!deviceId) {
    return res.status(400).send({
      message: 'EULA consent: Failed to get device id'
    });
  }

  await deleteEULAConsent(deviceId);
  return res.status(200).send({
    message: 'EULA consent deleted'
  });
});

router.get(`/eula-consent/:deviceId`, async function (req: Request, res: any) {
  const deviceId = getBoundedString(req.params.deviceId, 100);
  if (!deviceId) {
    return res.status(400).send({
      message: 'EULA consent: Invalid device id'
    });
  }

  const consent = await fetchEULAConsent(deviceId);
  return res.status(200).send(consent ?? {});
});
