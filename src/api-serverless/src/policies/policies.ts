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

// ISO 3166-1 alpha-2 codes supported by AWS WAF GeoMatchStatement. Unknown
// values such as XX must fall back to FindIP, not imply a non-EU visitor.
const COUNTRY_CODES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
   BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
   CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
   DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
   GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
   HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
   KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
   MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ OM
   PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA
   RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
   TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
   UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`
    .trim()
    .split(/\s+/)
);

type ApiGatewaySourceIpContext = {
  readonly identity?: { readonly sourceIp?: unknown } | null;
  readonly http?: { readonly sourceIp?: unknown } | null;
};

/**
 * Deploy only behind a WAF that overwrites this header on every Allow path.
 * An API Gateway context alone does not authenticate a caller-supplied header.
 * Local HTTP requests and missing or invalid values keep using FindIP.
 */
export function getWafCountry(req: Request): string | null {
  const gatewayRequest = req as Request & {
    readonly requestContext?: ApiGatewaySourceIpContext | null;
    readonly apiGateway?: {
      readonly event?: {
        readonly multiValueHeaders?: Record<string, unknown> | null;
      };
    };
  };
  if (!normalizeIp(gatewayRequest.requestContext?.identity?.sourceIp)) {
    return null;
  }
  const country = req.headers['x-amzn-waf-country'];
  if (typeof country !== 'string' || !COUNTRY_CODES.has(country)) {
    return null;
  }
  // serverless-http can prefer a single-value header over a duplicate entry
  // in multiValueHeaders. Check the original event before trusting that value.
  const originalHeaders = Object.entries(
    gatewayRequest.apiGateway?.event?.multiValueHeaders ?? {}
  ).filter(([name]) => name.toLowerCase() === 'x-amzn-waf-country');
  if (originalHeaders.length === 0) {
    return country;
  }
  if (originalHeaders.length !== 1) {
    return null;
  }
  const values = originalHeaders[0][1];
  return Array.isArray(values) && values.length === 1 && values[0] === country
    ? country
    : null;
}

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
