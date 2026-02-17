import { env } from '@/env';
import { Time } from '@/time';
import { ApiSeizeSettings } from './generated/models/ApiSeizeSettings';
import { PageSortDirection } from './page-request';

export const seizeSettings = (): ApiSeizeSettings => {
  const rememes_submission_tdh_threshold =
    env.getIntOrNull('REMEMED_SUBMISSION_TDH_THRESHOLD') ?? 6942;
  const all_drops_notifications_subscribers_limit =
    env.getIntOrNull('ALL_DROPS_NOTIFICATIONS_SUBSCRIBERS_LIMIT') ?? 15;

  const memes_wave_id = env.getStringOrNull('MAIN_STAGE_WAVE_ID');
  const curation_wave_id = env.getStringOrNull('CURATION_WAVE_ID');

  return {
    rememes_submission_tdh_threshold,
    all_drops_notifications_subscribers_limit,
    memes_wave_id,
    curation_wave_id
  };
};

export const ACCESS_CONTROL_ALLOW_ORIGIN_HEADER = 'Access-Control-Allow-Origin';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const JSON_HEADER_VALUE = 'application/json';
export const DEFAULT_PAGE_SIZE = 50;
export const NFTS_PAGE_SIZE = 101;
export const DISTRIBUTION_PAGE_SIZE = 250;
export const SORT_DIRECTIONS = [PageSortDirection.ASC, PageSortDirection.DESC];
export const CACHE_TIME_MS = Time.minutes(1).toMillis();

export const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS', 'HEAD', 'DELETE'],
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
