import { validateRememe, validateRememeAdd } from './rememes_validation';
import * as db from '../../../db-api';
import { asyncRouter } from '../async.router';
import {
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  CONTENT_TYPE_HEADER,
  corsOptions,
  DEFAULT_PAGE_SIZE,
  DISTRIBUTION_PAGE_SIZE,
  JSON_HEADER_VALUE,
  SORT_DIRECTIONS
} from '../api-constants';
import { REMEMES_SORT } from '../api-filters';
import { returnPaginatedResult } from '../api-helpers';

const router = asyncRouter();

router.get(``, async function (req: any, res: any) {
  const memeIds = req.query.meme_id;
  const pageSize: number =
    req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;
  const contract = req.query.contract;
  const id = req.query.id;
  const tokenType = req.query.token_type;

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
    .then(async (result) => {
      result.data.map((a: any) => {
        a.metadata = JSON.parse(a.metadata);
        a.media = JSON.parse(a.media);
        a.contract_opensea_data = JSON.parse(a.contract_opensea_data);
        a.meme_references = JSON.parse(a.meme_references);
        a.replicas = a.replicas.split(',');
      });
      await returnPaginatedResult(result, req, res, true);
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

router.post(`/add`, validateRememeAdd, function (req: any, res: any) {
  const body = req.validatedBody;
  const valid = body.valid;
  res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
  if (valid) {
    db.addRememe(req.body.address, body).then(() => {
      res.status(201).send(JSON.stringify(body));
      res.end();
    });
  } else {
    res.status(400).send(JSON.stringify(body));
    res.end();
  }
});

export default router;
