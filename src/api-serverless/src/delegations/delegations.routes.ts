import { asyncRouter } from '../async.router';

import {
  fetchDelegations,
  fetchDelegationsByUseCase,
  fetchMintingDelegations
} from '../../../db-api';
import { returnPaginatedResult } from '../api-helpers';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();

export default router;

router.get(`/`, cacheRequest(), async function (req: any, res: any) {
  const use_cases = req.query.use_case;
  const collections = req.query.collection;
  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;
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

    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    await fetchMintingDelegations(wallet, pageSize, page).then((result) => {
      return returnPaginatedResult(result, req, res);
    });
  }
);

router.get(`/:wallet`, cacheRequest(), async function (req: any, res: any) {
  const wallet = req.params.wallet;

  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;

  await fetchDelegations(wallet, pageSize, page).then((result) => {
    return returnPaginatedResult(result, req, res);
  });
});
