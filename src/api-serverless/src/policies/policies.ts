import { Request, Response, NextFunction } from 'express';
import { Logger } from '../../../logging';
import { fetchRandomImage } from '../../../db-api';

const logger = Logger.get('API_POLICIES');

const geoip = require('geoip-lite');

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
  let ip = req.ip?.split(',')[0].trim();
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  if (isLocalhost(ip)) {
    return next();
  }

  const geoInfo = geoip.lookup(ip);
  const country = geoInfo?.country;

  if (!country || BLOCKED_COUNTRIES.includes(country)) {
    logger.info(`[REQUEST FROM BLOCKED COUNTRY] : [${country} : ${ip}]`);
    res.statusCode = 401;
    const image = await fetchRandomImage();
    return res.status(403).send({
      country: country,
      image: image[0].scaled ? image[0].scaled : image[0].image
    });
  }

  next();
};

const isLocalhost = (ip: string) => {
  return ip === '127.0.0.1' || ip === '::1';
};
