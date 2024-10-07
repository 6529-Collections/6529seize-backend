import { Request } from 'express';
import { Logger } from '../../../logging';
import axios from 'axios';
import * as mcache from 'memory-cache';
import { Time } from '../../../time';

const logger = Logger.get('API_POLICIES');

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

export const isLocalhost = (ip: string) => {
  return ip === '127.0.0.1' || ip === '::1';
};

export async function getIpInfo(ip: string): Promise<{
  city_name: string;
  country_name: string;
  country: string;
} | null> {
  try {
    const key = 'ipInfo_' + ip;
    const cacheHit = mcache.get(key);
    if (cacheHit) {
      return JSON.parse(cacheHit);
    }
    const url = `https://api.findip.net/${ip}/?token=${process.env.FINDIP_API_TOKEN}`;
    const response = await axios.get(url, { timeout: 3000 });
    const data = response.data;
    const resp = {
      city_name: data?.city?.names?.en,
      country_name: data?.country?.names?.en,
      country: data?.country?.iso_code
    };
    mcache.put(key, JSON.stringify(data), Time.days(1).toMillis());
    return resp;
  } catch (error) {
    logger.error(error);
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

export const isEUCountry = (country: string) => {
  return EU_EEA_COUNTRIES.includes(country);
};
