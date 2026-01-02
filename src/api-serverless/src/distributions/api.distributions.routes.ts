import { ethers } from 'ethers';
import { Request, Response } from 'express';
import { UnauthorisedException } from '../../../exceptions';
import { numbers } from '../../../numbers';
import { evictKeyFromRedisCache } from '../../../redis';
import { DISTRIBUTION_PAGE_SIZE } from '../api-constants';
import {
  getCacheKeyPatternForPath,
  getPage,
  getPageSize,
  giveReadReplicaTimeToCatchUp,
  returnJsonResult,
  returnPaginatedResult
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { cacheRequest } from '../request-cache';
import { authenticateSubscriptionsAdmin } from '../subscriptions/api.subscriptions.allowlist';
import {
  fetchDistributionOverview,
  fetchDistributionPhases,
  fetchDistributions
} from './api.distributions.db';
import {
  insertAutomaticAirdrops,
  populateDistributionNormalized
} from './api.distributions.service';

const router = asyncRouter();

function validateSubscriptionAdminAndParams(
  req: Request<any, any, any, any>,
  res: Response
): { contract: string; cardId: number } | null {
  const authenticated = authenticateSubscriptionsAdmin(req);
  if (!authenticated) {
    throw new UnauthorisedException(
      'Only Subscription Admins can perform this action'
    );
  }

  const contract = req.params.contract;
  const cardId = numbers.parseIntOrNull(req.params.id);

  if (cardId === null) {
    res.status(400).send({
      success: false,
      error: 'Invalid id parameter'
    });
    return null;
  }

  return { contract, cardId };
}

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

    const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
    const page = getPage(req);

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
    const cardId = numbers.parseIntOrNull(req.params.id);

    if (cardId === null) {
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
    const params = validateSubscriptionAdminAndParams(req, res);
    if (!params) {
      return;
    }
    const { contract, cardId } = params;

    await populateDistributionNormalized(contract, cardId);

    await giveReadReplicaTimeToCatchUp();

    const overviewCacheKey = getCacheKeyPatternForPath(
      `/api/distributions/${contract}/${cardId}/overview`
    );
    await evictKeyFromRedisCache(overviewCacheKey);

    return await returnJsonResult(
      {
        success: true,
        message: 'Distribution normalized successfully'
      },
      req,
      res
    );
  }
);

router.post(
  `/distributions/:contract/:id/automatic_airdrops`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    const params = validateSubscriptionAdminAndParams(req, res);
    if (!params) {
      return;
    }
    const { contract, cardId } = params;

    const { csv: csvData } = req.body;
    if (!csvData || typeof csvData !== 'string') {
      return res.status(400).send({
        success: false,
        error: 'CSV data is required in request body'
      });
    }

    const airdrops: Array<{ address: string; count: number }> = [];
    const lines = csvData.trim().split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(',');

      if (parts.length !== 2) {
        return res.status(400).send({
          success: false,
          error: `Invalid CSV format at line ${i + 1}: expected 2 columns, got ${parts.length}`
        });
      }

      const address = parts[0]?.trim();
      const countStr = parts[1]?.trim();
      const count = numbers.parseIntOrNull(countStr);

      if (!address) {
        return res.status(400).send({
          success: false,
          error: `Invalid CSV format at line ${i + 1}: address is empty`
        });
      }

      if (!ethers.utils.isAddress(address)) {
        return res.status(400).send({
          success: false,
          error: `Invalid CSV format at line ${i + 1}: "${address}" is not a valid Ethereum address`
        });
      }

      if (count === null) {
        return res.status(400).send({
          success: false,
          error: `Invalid CSV format at line ${i + 1}: count "${countStr}" is not a valid number`
        });
      }

      if (count <= 0) {
        return res.status(400).send({
          success: false,
          error: `Invalid CSV format at line ${i + 1}: count must be greater than 0, got ${count}`
        });
      }

      airdrops.push({ address, count });
    }

    if (airdrops.length === 0) {
      return res.status(400).send({
        success: false,
        error: 'No valid airdrop entries found in CSV'
      });
    }

    await insertAutomaticAirdrops(contract, cardId, airdrops);

    await giveReadReplicaTimeToCatchUp();

    const baseCacheKey = getCacheKeyPatternForPath(
      `/api/distributions/${contract}/${cardId}/overview`
    );
    await evictKeyFromRedisCache(baseCacheKey);

    return await returnJsonResult(
      {
        success: true,
        message: 'Successfully uploaded automatic airdrops'
      },
      req,
      res
    );
  }
);

export default router;
