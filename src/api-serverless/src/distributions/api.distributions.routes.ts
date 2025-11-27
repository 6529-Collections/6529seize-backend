import { Request, Response } from 'express';
import { UnauthorisedException } from '../../../exceptions';
import { DEFAULT_PAGE_SIZE, DISTRIBUTION_PAGE_SIZE } from '../api-constants';
import { returnJsonResult, returnPaginatedResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { cacheRequest } from '../request-cache';
import { authenticateSubscriptionsAdmin } from '../subscriptions/api.subscriptions.allowlist';
import {
  fetchDistributionOverview,
  fetchDistributionPhases,
  fetchDistributions
} from './api.distributions.db';
import { populateDistributionNormalized } from './api.distributions.service';

const router = asyncRouter();

router.get(
  `/distribution_phases/:contract/:nft_id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;

    await fetchDistributionPhases(contract, nftId).then(async (result) => {
      await returnPaginatedResult(result, req, res);
    });
  }
);

router.get(
  `/distributions`,
  cacheRequest(),
  async function (req: any, res: any) {
    const search = req.query.search;
    const cards = req.query.card_id;
    const contracts = req.query.contract;
    const wallets = req.query.wallet;

    const pageSize: number =
      req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
        ? Number.parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? Number.parseInt(req.query.page) : 1;

    await fetchDistributions(
      search,
      cards,
      contracts,
      wallets,
      pageSize,
      page
    ).then(async (result) => {
      await returnPaginatedResult(result, req, res);
    });
  }
);

router.get(
  `/distributions/:contract/:id/overview`,
  needsAuthenticatedUser(),
  cacheRequest(),
  async function (req: any, res: any) {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can fetch distribution overview'
      );
    }

    const contract = req.params.contract;
    const cardId = Number.parseInt(req.params.id);

    if (Number.isNaN(cardId)) {
      return res.status(400).send({
        success: false,
        error: 'Invalid id parameter'
      });
    }

    const overview = await fetchDistributionOverview(contract, cardId);
    return await returnJsonResult(overview, req, res);
  }
);

router.post(
  `/distributions/:contract/:id/normalize`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can normalize distributions'
      );
    }

    const contract = req.params.contract;
    const cardId = Number.parseInt(req.params.id);

    if (Number.isNaN(cardId)) {
      return res.status(400).send({
        success: false,
        error: 'Invalid id parameter'
      });
    }

    try {
      await populateDistributionNormalized(contract, cardId);
      return await returnJsonResult(
        {
          success: true,
          message: 'Distribution normalized successfully'
        },
        req,
        res
      );
    } catch (err) {
      return res.status(500).send({
        success: false,
        error: err
      });
    }
  }
);

export default router;
