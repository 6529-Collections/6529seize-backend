import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { resolveSortDirection, returnPaginatedResult } from '../api-helpers';
import {
  fetchAllNftOwners,
  fetchNftOwnersForConsolidation
} from './api.nft-owners.db';
import { NftOwnerPage } from '../generated/models/NftOwnerPage';
import { ApiResponse } from '../api-response';

const router = asyncRouter();

export default router;

router.get(
  '/',
  async function (
    req: Request<
      any,
      any,
      any,
      {
        contract?: string;
        token_id?: string;
        sort_direction: any;
        page?: number;
        page_size?: number;
      }
    >,
    res: Response<ApiResponse<NftOwnerPage>>
  ) {
    const contract = req.query.contract;
    const tokenId = req.query.token_id;
    const sortDir = resolveSortDirection(req.query.sort_direction);
    const page = req.query.page ?? 1;
    const pageSize = req.query.page_size ?? DEFAULT_PAGE_SIZE;
    const result = await fetchAllNftOwners(
      contract,
      tokenId,
      page,
      pageSize,
      sortDir
    );
    return returnPaginatedResult(result, req, res);
  }
);

router.get(
  `/consolidation/:consolidation_key`,
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      {
        contract?: string;
        token_id?: string;
        page?: number;
        page_size?: number;
      }
    >,
    res: Response<ApiResponse<NftOwnerPage>>
  ) {
    const consolidationKey = req.params.consolidation_key;
    const contract = req.query.contract;
    const tokenId = req.query.token_id;

    const page = req.query.page ?? 1;
    const pageSize = req.query.page_size ?? DEFAULT_PAGE_SIZE;

    const results = await fetchNftOwnersForConsolidation(
      consolidationKey,
      contract,
      tokenId,
      page,
      pageSize
    );
    return returnPaginatedResult(results, req, res);
  }
);
