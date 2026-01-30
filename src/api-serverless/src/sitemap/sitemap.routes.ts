import { Request, Response } from 'express';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import {
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_TOKENS_TABLE
} from '../../../nextgen/nextgen_constants';
import { returnPaginatedResult } from '../api-helpers';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();

const PAGE_SIZE = 200;

interface PaginatedResponse<T> {
  count: number;
  page: number;
  next: string | null;
  data: T[];
}

async function handlePaginatedRequest(
  req: Request<any, any, any, { page?: number; page_size?: number }>,
  res: Response<ApiResponse<PaginatedResponse<number>>>,
  options: {
    table: string;
    contract?: string;
    field?: string;
  }
) {
  const { contract, table, field } = options;

  const filter = contract ? `WHERE contract = :contract` : '';
  const params = contract ? { contract } : {};

  const pageSize: number =
    req.query.page_size && req.query.page_size <= PAGE_SIZE
      ? req.query.page_size
      : PAGE_SIZE;
  const page: number = req.query.page || 1;

  const results = await fetchPaginated<any>(
    table,
    params,
    'id asc',
    pageSize,
    page,
    filter,
    field ?? 'id'
  );

  const ids = results.data.map((r) => r[field ?? 'id']);
  return returnPaginatedResult(
    {
      count: results.count,
      page: results.page,
      next: results.next,
      data: ids
    },
    req,
    res
  );
}

router.get('/memes', cacheRequest(), (req, res) =>
  handlePaginatedRequest(req, res, {
    contract: MEMES_CONTRACT,
    table: NFTS_TABLE
  })
);

router.get('/gradient', cacheRequest(), (req, res) =>
  handlePaginatedRequest(req, res, {
    contract: GRADIENT_CONTRACT,
    table: NFTS_TABLE
  })
);

router.get('/meme-lab', cacheRequest(), (req, res) =>
  handlePaginatedRequest(req, res, {
    contract: MEMELAB_CONTRACT,
    table: NFTS_MEME_LAB_TABLE
  })
);

router.get('/nextgen/tokens', cacheRequest(), (req, res) =>
  handlePaginatedRequest(req, res, {
    table: NEXTGEN_TOKENS_TABLE
  })
);

router.get('/nextgen/collections', cacheRequest(), (req, res) =>
  handlePaginatedRequest(req, res, {
    table: NEXTGEN_COLLECTIONS_TABLE,
    field: 'name'
  })
);

export default router;
