import { Request, Response } from 'express';
import * as Joi from 'joi';
import * as db from '@/api/oracle/api.oracle.db';
import { asyncRouter } from '@/api/async.router';
import * as SwaggerUI from 'swagger-ui-express';
import { numbers } from '@/numbers';
import { CustomApiCompliantException } from '@/exceptions';
import { getValidatedByJoiOrThrow } from '@/api/validation';

const YAML = require('yamljs');

const router = asyncRouter();

export default router;

type TdhAboveParams = {
  value: number;
  extra?: 'entries';
};

const TdhAboveParamsSchema = Joi.object<TdhAboveParams>({
  value: Joi.number().required(),
  extra: Joi.string().valid('entries').optional()
});

type OracleNftsParams = {
  contract?: string;
  id?: number;
};

const OracleNftsParamsSchema = Joi.object<OracleNftsParams>({
  contract: Joi.string().optional(),
  id: Joi.number().integer().optional()
});

const swaggerDocumentOracle = YAML.load('openapi.oracle.yaml');
router.use(
  '/docs',
  SwaggerUI.serveFiles(swaggerDocumentOracle, { explorer: true }),
  SwaggerUI.setup(swaggerDocumentOracle, {
    customSiteTitle: '6529 Oracle TDH API',
    customCss: '.topbar { display: none }'
  })
);

router.get(
  '/tdh/total',
  async function (req: Request<any, any, any, any>, res: any) {
    const result = await db.fetchTotalTDH();
    return res.json(result);
  }
);

router.get(
  '/tdh/above/:value/:extra?',
  async function (
    req: Request<
      {
        value: number;
        extra?: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const params = getValidatedByJoiOrThrow(req.params, TdhAboveParamsSchema);
    const includeEntries = params.extra === 'entries';
    const value = params.value;
    const result = await db.fetchTDHAbove(value, includeEntries);
    return res.json(result);
  }
);

router.get(
  '/tdh/percentile/:value',
  async function (
    req: Request<
      {
        value: number;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const percentile = req.params.value;
    if (
      !percentile ||
      Number.isNaN(percentile) ||
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

    const resolvedPercentile = Number(percentile) / 100;
    const result = await db.fetchTDHPercentile(resolvedPercentile);
    return res.json(result);
  }
);

router.get(
  '/tdh/cutoff/:value',
  async function (
    req: Request<
      {
        value: number;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const cutoff = req.params.value;
    if (!Number.isInteger(Number(cutoff)) || cutoff < 1) {
      return res
        .status(400)
        .send('Invalid cutoff value. Please provide a non-negative integer.');
    }

    const result = await db.fetchTDHCutoff(Number(cutoff));
    return res.json(result);
  }
);

router.get(
  '/address/:address',
  async function (
    req: Request<
      {
        address: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const address = req.params.address;
    const result = await db.fetchSingleAddressTDH(address);
    return res.json(result);
  }
);

router.get(
  '/address/:address/breakdown',
  async function (
    req: Request<
      {
        address: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const address = req.params.address;
    const result = await db.fetchSingleAddressTDHBreakdown(address);
    return res.json(result);
  }
);

router.get(
  '/address/:address/memes_seasons/:season?',
  async function (
    req: Request<
      {
        address: string;
        season?: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const address = req.params.address;
    const season = req.params.season;
    const result = await db.fetchSingleAddressTDHMemesSeasons(address);
    if (season) {
      try {
        const seasonNumber = numbers.parseIntOrNull(season);
        if (seasonNumber === null) {
          throw new Error('Invalid season number');
        }
        const seasonResult = result.seasons.filter(
          (r: any) => r.season === seasonNumber
        );
        if (seasonResult.length === 0) {
          throw new Error('Season not found');
        }
        return res.json({
          ...seasonResult[0],
          block: result.block
        });
      } catch (e: any) {
        return res.status(400).send({ error: e.message });
      }
    }
    return res.json(result);
  }
);

router.get(
  '/address/:address/:contract/:id',
  async function (
    req: Request<
      {
        address: string;
        contract: string;
        id: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const address = req.params.address;
    const contract = req.params.contract;
    const id = req.params.id;
    const tokenId = numbers.parseIntOrNull(id);
    if (tokenId === null) {
      return res.status(400).send({ error: 'Invalid token id' });
    }
    const result = await db.fetchSingleAddressTDHForNft(
      address,
      contract,
      tokenId
    );
    return res.json(result);
  }
);

router.get(
  '/nfts/memes_seasons/:season?',
  async function (
    req: Request<
      {
        season?: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const season = req.params.season;
    const result = await db.fetchSeasonsTDH(season);
    if (season) {
      const seasonNumber = numbers.parseIntOrNull(season);
      if (seasonNumber === null) {
        return res.status(400).send({ error: 'Invalid season number' });
      }
      if (result.seasons.length === 0) {
        return res.status(404).send({ error: 'Season not found' });
      }
      return res.json({
        ...result.seasons[0],
        block: result.block
      });
    }
    return res.json(result);
  }
);

router.get(
  '/nfts/:contract?/:id?',
  async function (
    req: Request<
      {
        contract?: string;
        id?: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const params = getValidatedByJoiOrThrow(req.params, OracleNftsParamsSchema);
    const contract = params.contract;
    const tokenId = params.id;
    const result = await db.fetchNfts(contract, tokenId);
    if (contract && tokenId !== undefined) {
      if (result.nfts.length === 0) {
        return res.status(404).send({ error: 'NFT not found' });
      } else {
        return res.json({
          ...result.nfts[0],
          block: result.block
        });
      }
    }
    return res.json(result);
  }
);

// Keep terminal responses for legacy registry clients without reading or writing data.
function retiredPrenodeRegistry(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  throw new CustomApiCompliantException(
    410,
    '6529 Prenodes have been deprecated. Use the 6529 Desktop app to calculate TDH.'
  );
}

router.post('/register-prenode', retiredPrenodeRegistry);
router.get('/prenodes', retiredPrenodeRegistry);
