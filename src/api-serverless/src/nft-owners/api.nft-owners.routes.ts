import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { returnPaginatedResult } from '../api-helpers';
import { fetchNftOwnersForConsolidation } from './api.nft-owners.db';

const router = asyncRouter();

export default router;

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
    res: any
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
