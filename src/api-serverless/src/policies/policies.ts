import { Request } from 'express';
import { isIP } from 'node:net';
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

const FINDIP_API_BASE_URL = 'https://api.findip.net/';
const IPV4_MAPPED_IPV6_PREFIX = '::ffff:';
// Plain IPv4/IPv6 literals only: no zone identifiers, ports or separators.
const IP_LITERAL_CHARACTERS = /^[0-9a-f.:]+$/i;

type ApiGatewaySourceIpContext = {
  readonly identity?: { readonly sourceIp?: unknown } | null;
  readonly http?: { readonly sourceIp?: unknown } | null;
};

/**
 * Returns the value as a plain IPv4/IPv6 literal (IPv4-mapped IPv6 addresses
 * are unwrapped to IPv4), or '' when it is not one.
 */
export function normalizeIp(value: unknown): string {
  if (typeof value !== 'string' || !IP_LITERAL_CHARACTERS.test(value)) {
    return '';
  }
  if (value.toLowerCase().startsWith(IPV4_MAPPED_IPV6_PREFIX)) {
    const mapped = value.substring(IPV4_MAPPED_IPV6_PREFIX.length);
    if (isIP(mapped) === 4) {
      return mapped;
    }
  }
  return isIP(value) ? value : '';
}

function buildFindIpUrl(ip: string): string {
  const url = new URL(FINDIP_API_BASE_URL);
  url.pathname = `/${ip}/`;
  url.searchParams.set('token', process.env.FINDIP_API_TOKEN ?? '');
  return url.toString();
}

export async function getIpInfo(ip: string): Promise<{
  city_name: string;
  country_name: string;
  country: string;
} | null> {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) {
    return null;
  }
  try {
    const key = 'ipInfo_' + normalizedIp;
    const cacheHit = mcache.get(key);
    if (cacheHit) {
      return JSON.parse(cacheHit);
    }
    const response = await axios.get(buildFindIpUrl(normalizedIp), {
      timeout: 3000
    });
    const data = response.data;
    const resp = {
      city_name: data?.city?.names?.en,
      country_name: data?.country?.names?.en,
      country: data?.country?.iso_code
    };
    mcache.put(key, JSON.stringify(resp), Time.days(1).toMillis());
    return resp;
  } catch (error) {
    logger.error(error);
    return null;
  }
}

/**
 * Client IP derived from transport-level sources only: the API Gateway source
 * IP that serverless-http copies from the Lambda event (REST and HTTP API
 * payloads), or the socket peer when running the local server. Client-supplied
 * forwarding headers such as X-Forwarded-For are never consulted.
 */
export const getIp = (req: Request): string => {
  const requestContext = (
    req as Request & { requestContext?: ApiGatewaySourceIpContext | null }
  ).requestContext;
  const sourceIp =
    requestContext?.identity?.sourceIp ??
    requestContext?.http?.sourceIp ??
    req.socket?.remoteAddress;
  return normalizeIp(sourceIp);
};

export const isEUCountry = (country: string) => {
  return EU_EEA_COUNTRIES.includes(country);
};
