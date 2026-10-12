import { asyncRouter } from '../async.router';

import {
  fetchDelegations,
  fetchDelegationsByUseCase,
  fetchMintingDelegations
} from '../../../db-api';
import { getPage, getPageSize, returnPaginatedResult } from '../api-helpers';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();

export default router;

router.get(`/`, cacheRequest(), async function (req: any, res: any) {
  const use_cases = req.query.use_case;
  const collections = req.query.collection;
  const pageSize = getPageSize(req);
  const page = getPage(req);
  const showExpired = !!(
    req.query.show_expired && req.query.show_expired == 'true'
  );
  const block = req.query.block;

  await fetchDelegationsByUseCase(
    collections,
    use_cases,
    showExpired,
    pageSize,
    page,
    block
  ).then((result) => {
    return returnPaginatedResult(result, req, res);
  });
});

router.get(
  `/minting/:wallet`,
  cacheRequest(),
  async function (req: any, res: any) {
    const wallet = req.params.wallet;

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await fetchMintingDelegations(wallet, pageSize, page).then((result) => {
      return returnPaginatedResult(result, req, res);
    });
  }
);

router.get(`/:wallet`, cacheRequest(), async function (req: any, res: any) {
  const wallet = req.params.wallet;

  const pageSize = getPageSize(req);
  const page = getPage(req);

  await fetchDelegations(wallet, pageSize, page).then((result) => {
    return returnPaginatedResult(result, req, res);
  });
});
