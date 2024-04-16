import { Time } from '../../time';
import { PageSortDirection } from './page-request';

export const SEIZE_SETTINGS = {
  rememes_submission_tdh_threshold: 6942
};

export const ACCESS_CONTROL_ALLOW_ORIGIN_HEADER =
  'Access-Control-Allow-Headers';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const JSON_HEADER_VALUE = 'application/json';
export const DEFAULT_PAGE_SIZE = 50;
export const NFTS_PAGE_SIZE = 101;
export const DISTRIBUTION_PAGE_SIZE = 250;
export const SORT_DIRECTIONS = [PageSortDirection.ASC, PageSortDirection.DESC];
export const CACHE_TIME_MS = Time.minutes(1).toMillis();

export const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'DELETE'],
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
  next: string | null | boolean;
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
