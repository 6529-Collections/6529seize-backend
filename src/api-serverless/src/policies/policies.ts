import { Request, Response, NextFunction } from 'express';
import { Logger } from '../../../logging';
import { fetchRandomImage } from '../../../db-api';
import fetch from 'node-fetch';

const logger = Logger.get('API_POLICIES');

export const BLOCKED_COUNTRIES = [
  'KP', // North Korea
  'CU', // Cuba
  'IR', // Iran
  'SY' // Syria
];

const EU_EEA_COUNTRIES = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
  'IS', // Iceland
  'LI', // Liechtenstein
  'NO' // Norway
];

export const checkPolicies = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.method === 'OPTIONS') {
    return next();
  }

  let ip = getIp(req);

  if (!ip) {
    const image = await fetchRandomImage();
    return res.status(403).send({
      message: 'Failed to get IP address',
      image: image[0].scaled ? image[0].scaled : image[0].image
    });
  }

  if (isLocalhost(ip)) {
    return next();
  }

  const ipInfo = await getIpInfo(ip);
  const country = ipInfo?.country;

  if (country && isBlockedCountry(country)) {
    logger.info(`[REQUEST FROM BLOCKED COUNTRY] : [${country} : ${ip}]`);
    const image = await fetchRandomImage();
    return res.status(403).send({
      country: country,
      image: image[0].scaled ? image[0].scaled : image[0].image
    });
  }

  return next();
};

export const isLocalhost = (ip: string) => {
  return ip === '127.0.0.1' || ip === '::1';
};

export async function getIpInfo(ip: string): Promise<{
  city_name: string;
  country_name: string;
  country: string;
} | null> {
  try {
    const url = `https://api.findip.net/${ip}/?token=${process.env.FINDIP_API_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    return {
      city_name: data?.city?.names?.en,
      country_name: data?.country?.names?.en,
      country: data?.country?.iso_code
    };
  } catch (error) {
    console.error('Failed to fetch client IP:', error);
    return null;
  }
}

export const getIp = (req: Request): string => {
  let ip = req.ip;
  if (ip?.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip ?? '';
};

export const isBlockedCountry = (country: string) => {
  return BLOCKED_COUNTRIES.includes(country);
};

export const isEUCountry = (country: string) => {
  return EU_EEA_COUNTRIES.includes(country);
};
