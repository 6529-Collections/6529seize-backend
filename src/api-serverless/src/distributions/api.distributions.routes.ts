import { Request, Response } from 'express';
import { Readable } from 'stream';
import { UnauthorisedException } from '../../../exceptions';
import { DEFAULT_PAGE_SIZE, DISTRIBUTION_PAGE_SIZE } from '../api-constants';
import {
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

const csv = require('csv-parser');

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

    await populateDistributionNormalized(contract, cardId);

    await giveReadReplicaTimeToCatchUp();

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
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can create automatic airdrops'
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

    const { csv: csvData } = req.body;
    if (!csvData || typeof csvData !== 'string') {
      return res.status(400).send({
        success: false,
        error: 'CSV data is required in request body'
      });
    }

    const airdrops: Array<{ address: string; count: number }> = [];

    const bufferStream = new Readable();
    bufferStream.push(csvData);
    bufferStream.push(null);

    await new Promise<void>((resolve, reject) => {
      bufferStream
        .pipe(csv({ headers: false }))
        .on('data', (data: any) => {
          const address = data[0]?.trim();
          const count = Number.parseInt(data[1]?.trim() || '0');

          if (!address) {
            return;
          }

          if (Number.isNaN(count) || count <= 0) {
            return;
          }

          airdrops.push({ address, count });
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (err: Error) => {
          reject(err);
        });
    });

    if (airdrops.length === 0) {
      return res.status(400).send({
        success: false,
        error: 'No valid airdrop entries found in CSV'
      });
    }

    await insertAutomaticAirdrops(contract, cardId, airdrops);

    await giveReadReplicaTimeToCatchUp();

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
