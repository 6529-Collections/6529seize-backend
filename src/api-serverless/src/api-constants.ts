export const ACCESS_CONTROL_ALLOW_ORIGIN_HEADER =
  'Access-Control-Allow-Headers';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const JSON_HEADER_VALUE = 'application/json';
export const DEFAULT_PAGE_SIZE = 50;

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
