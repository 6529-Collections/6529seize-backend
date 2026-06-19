import { Time } from '../../time';
import { PageSortDirection } from './page-request';
import {
  getAllowedWebAuthCredentialOrigins,
  normalizeWebAppOrigin
} from './web-app-origins';
export const ACCESS_CONTROL_ALLOW_ORIGIN_HEADER = 'Access-Control-Allow-Origin';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const JSON_HEADER_VALUE = 'application/json';
export const DEFAULT_PAGE_SIZE = 50;
export const NFTS_PAGE_SIZE = 101;
export const DISTRIBUTION_PAGE_SIZE = 250;
export const SORT_DIRECTIONS = [PageSortDirection.ASC, PageSortDirection.DESC];
export const CACHE_TIME_MS = Time.minutes(1).toMillis();

type ApiCorsOptions = {
  origin: string | boolean;
  methods: string[];
  allowedHeaders: string[];
  credentials?: true;
};

export const corsOptions: ApiCorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'HEAD', 'DELETE'],
  allowedHeaders: [
    'Content-Type',
    'x-6529-auth',
    'Origin',
    'Accept',
    'X-Requested-With',
    'Authorization'
  ]
};

const WEB_AUTH_CREDENTIAL_ROUTE_PATHS = new Set([
  '/api/auth/session-login',
  '/api/auth/session-refresh',
  '/api/auth/session-logout',
  '/api/auth/connection-share',
  '/api/auth/connection-share/redeem'
]);

export function getCorsOptionsForRequest(
  path: string,
  originHeader: unknown,
  apiHostHeader: unknown
): ApiCorsOptions {
  if (!WEB_AUTH_CREDENTIAL_ROUTE_PATHS.has(path)) {
    return corsOptions;
  }

  const origin = getAllowedWebAuthCredentialOrigin(originHeader, apiHostHeader);
  if (!origin) {
    return { ...corsOptions, origin: false };
  }

  return {
    ...corsOptions,
    origin,
    credentials: true
  };
}

export function isWebAuthCredentialOriginAllowed(
  origin: string | null | undefined,
  apiHostHeader: unknown
): boolean {
  return getAllowedWebAuthCredentialOrigin(origin, apiHostHeader) !== null;
}

function getAllowedWebAuthCredentialOrigin(
  originHeader: unknown,
  apiHostHeader: unknown
): string | null {
  if (typeof originHeader !== 'string') {
    return null;
  }
  const origin = normalizeWebAppOrigin(originHeader);
  if (!origin) {
    return null;
  }
  const allowedOrigins = getAllowedWebAuthCredentialOrigins(apiHostHeader);
  return allowedOrigins.includes(origin) ? origin : null;
}

export interface PaginatedResponse<T> {
  count: number;
  page: number;
  next: string | null;
  data: T[];
}

export interface NFTSearchResult {
  id: number;
  name: string;
  contract: string;
  icon_url: string;
  thumbnail_url: string;
  image_url: string;
}
