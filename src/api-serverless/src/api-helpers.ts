import { Response } from 'express';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  corsOptions
} from './api-constants';

export function returnJsonResult(result: any, response: Response) {
  response.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  response.setHeader(
    ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
    corsOptions.allowedHeaders
  );
  response.json(result);
}
