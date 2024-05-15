import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { returnJsonResult } from '../api-helpers';
import {
  fetchTotalTDH,
  fetchTDHAbove,
  fetchTDHPercentile,
  fetchTDHCutoff,
  fetchSingleAddressTDHBreakdown,
  fetchSingleAddressTDHMemesSeasons,
  fetchSingleWalletTDH
} from './api.chainlink.db';

const router = asyncRouter();

export default router;

router.get(
  '/tdh/total',
  async function (req: Request<{}, any, any, {}>, res: any) {
    const result = await fetchTotalTDH();
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/above/:value',
  async function (
    req: Request<
      {
        value: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const value = Number(req.params.value);
    if (isNaN(value)) {
      return res.status(400).send({ error: 'Invalid value' });
    }
    const result = await fetchTDHAbove(value);
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/percentile/:value',
  async function (
    req: Request<
      {
        value: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const percentile = Number(req.params.value);
    if (
      !percentile ||
      isNaN(percentile) ||
      !Number.isInteger(Number(percentile)) ||
      percentile <= 0 ||
      percentile > 10000
    ) {
      return res
        .status(400)
        .send(
          'Invalid percentile value. Please provide an integer between 0 and 10000.'
        );
    }

    const resolvedPercentile = percentile / 100;
    const result = await fetchTDHPercentile(resolvedPercentile);
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/cutoff/:value',
  async function (
    req: Request<
      {
        value: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const cutoff = Number(req.params.value);
    if (!Number.isInteger(Number(cutoff)) || cutoff < 1) {
      return res
        .status(400)
        .send('Invalid cutoff value. Please provide a non-negative integer.');
    }

    const result = await fetchTDHCutoff(cutoff);
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/:wallet',
  async function (
    req: Request<
      {
        wallet: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const wallet = req.params.wallet;
    const result = await fetchSingleWalletTDH(wallet);
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/:address/breakdown',
  async function (
    req: Request<
      {
        address: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const address = req.params.address;
    const result = await fetchSingleAddressTDHBreakdown(address);
    return returnJsonResult(result, req, res);
  }
);

router.get(
  '/tdh/:address/memes_seasons',
  async function (
    req: Request<
      {
        address: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const address = req.params.address;
    const result = await fetchSingleAddressTDHMemesSeasons(address);
    return returnJsonResult(result, req, res);
  }
);
