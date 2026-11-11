import * as db from '@/db-api';
import {
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  CONTENT_TYPE_HEADER,
  corsOptions,
  DISTRIBUTION_PAGE_SIZE,
  JSON_HEADER_VALUE,
  SORT_DIRECTIONS
} from '../api-constants';
import { REMEMES_SORT } from '../api-filters';
import { getPage, getPageSize, returnPaginatedResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { validateRememe, validateRememeAdd } from './rememes_validation';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { canonicalRememeMemeId } from '@/rememe-meme-id';

const router = asyncRouter();

export const MAX_REMEMES_MEME_IDS = 50;

interface RememesQuery {
  meme_id?: string;
  contract?: string;
  id?: string;
  token_type?: string;
}

const ALPHANUMERIC = /^[A-Za-z0-9]+$/;
// Up to MAX_REMEMES_MEME_IDS comma-separated non-negative integers.
const MEME_IDS_PATTERN = new RegExp(
  `^\\d{1,20}(?:,\\d{1,20}){0,${MAX_REMEMES_MEME_IDS - 1}}$`
);

/** Rewrites each meme id to its canonical integer form ("007" -> "7"). */
function toCanonicalMemeIds(value: string, helpers: Joi.CustomHelpers) {
  const canonical: string[] = [];
  for (const piece of value.split(',')) {
    const id = canonicalRememeMemeId(piece);
    if (id === null) {
      return helpers.error('any.invalid');
    }
    canonical.push(id);
  }
  return canonical.join(',');
}

export const RememesQuerySchema: Joi.ObjectSchema<RememesQuery> =
  Joi.object<RememesQuery>({
    meme_id: Joi.string()
      .pattern(MEME_IDS_PATTERN, 'comma-separated meme ids')
      .custom(toCanonicalMemeIds, 'canonical meme ids')
      .allow(''),
    contract: Joi.string().pattern(ALPHANUMERIC).max(50).allow(''),
    id: Joi.string().pattern(ALPHANUMERIC).max(100).allow(''),
    token_type: Joi.string().pattern(ALPHANUMERIC).max(50).allow('')
  }).unknown(true);

/** Parses JSON columns in place and drops internal processing fields. */
export function toPublicRememeRow(row: any): any {
  row.metadata = JSON.parse(row.metadata);
  row.media = JSON.parse(row.media);
  row.contract_opensea_data = JSON.parse(row.contract_opensea_data);
  row.meme_references = JSON.parse(row.meme_references);
  row.replicas = row.replicas.split(',');
  // Media-processing diagnostics are internal; they are not part of the API.
  delete row.s3_image_processing_error;
  return row;
}

router.get(``, async function (req: any, res: any) {
  const query = getValidatedByJoiOrThrow(req.query, RememesQuerySchema);
  const memeIds = query.meme_id;
  const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
  const page = getPage(req);
  const contract = query.contract;
  const id = query.id;
  const tokenType = query.token_type;

  const sort =
    req.query.sort && REMEMES_SORT.includes(req.query.sort)
      ? req.query.sort
      : undefined;

  const sortDir =
    req.query.sort_direction &&
    SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
      ? req.query.sort_direction
      : 'desc';
  await db
    .fetchRememes(
      memeIds,
      pageSize,
      page,
      contract,
      id,
      tokenType,
      sort,
      sortDir
    )
    .then((result) => {
      result.data.forEach(toPublicRememeRow);
      return returnPaginatedResult(result, req, res);
    });
});

router.post(`/validate`, validateRememe, function (req: any, res: any) {
  const body = req.validatedBody;
  res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
  res
    .status(body.valid ? 200 : 400)
    .send(JSON.stringify(body))
    .end();
});

router.post(`/add`, validateRememeAdd, async function (req: any, res: any) {
  const body = req.validatedBody;
  const valid = body.valid;
  res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
  if (valid) {
    await db.addRememe(req.body.address, body);
    res.status(201).send(JSON.stringify(body));
    res.end();
  } else {
    res.status(400).send(JSON.stringify(body));
    res.end();
  }
});

export default router;
