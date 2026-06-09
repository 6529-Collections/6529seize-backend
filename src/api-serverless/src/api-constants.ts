import { Time } from '../../time';
import { PageSortDirection } from './page-request';
export const ACCESS_CONTROL_ALLOW_ORIGIN_HEADER = 'Access-Control-Allow-Origin';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const JSON_HEADER_VALUE = 'application/json';
export const DEFAULT_PAGE_SIZE = 50;
export const NFTS_PAGE_SIZE = 101;
export const DISTRIBUTION_PAGE_SIZE = 250;
export const SORT_DIRECTIONS = [PageSortDirection.ASC, PageSortDirection.DESC];
export const CACHE_TIME_MS = Time.minutes(1).toMillis();

const DEFAULT_CORS_ALLOWED_ORIGINS = [
  'https://6529.io',
  'https://www.6529.io',
  'https://app.6529.io'
];

const LOCAL_CORS_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
];

function getConfiguredCorsAllowedOrigins(): Set<string> {
  const configuredOrigins =
    process.env.CORS_ALLOWED_ORIGINS?.split(',')
      .map((it) => it.trim())
      .filter((it) => it.length > 0) ?? [];
  const localOrigins =
    process.env.NODE_ENV === 'production' ? [] : LOCAL_CORS_ALLOWED_ORIGINS;
  return new Set([
    ...DEFAULT_CORS_ALLOWED_ORIGINS,
    ...localOrigins,
    ...configuredOrigins
  ]);
}

function normalizeOrigin(origin: unknown): string | null {
  return typeof origin === 'string' && origin.trim().length > 0
    ? origin.trim()
    : null;
}

export function isCorsOriginAllowed(origin: string | undefined): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return true;
  }
  return getConfiguredCorsAllowedOrigins().has(normalizedOrigin);
}

export function getCorsResponseOrigin(origin: unknown): string {
  const normalizedOrigin = normalizeOrigin(origin);
  if (normalizedOrigin && isCorsOriginAllowed(normalizedOrigin)) {
    return normalizedOrigin;
  }
  return DEFAULT_CORS_ALLOWED_ORIGINS[0];
}

export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => callback(null, isCorsOriginAllowed(origin)),
  credentials: true,
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
