import { Request, Response } from 'express';
import * as db from './api.oracle.db';
import { asyncRouter } from '../async.router';
import * as SwaggerUI from 'swagger-ui-express';
import { getIp, isLocalhost } from '../policies/policies';
import { getPage, getPageSize } from '../api-helpers';
import { numbers } from '../../../numbers';

const YAML = require('yamljs');

const router = asyncRouter();

export default router;

function isValidIP(ip: string): boolean {
  const ipv4FormatRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4FormatRegex.test(ip)) {
    return false;
  }

  const octets = ip.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255);
}

const swaggerDocumentOracle = YAML.load('openapi.oracle.yaml');
router.use(
  '/docs',
  SwaggerUI.serveFiles(swaggerDocumentOracle, { explorer: true }),
  SwaggerUI.setup(swaggerDocumentOracle, {
    customSiteTitle: '6529 PreNode API',
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
    const value = req.params.value;
    const includeEntries = req.params.extra === 'entries';
    if (Number.isNaN(value)) {
      return res.status(400).send({ error: 'Invalid value' });
    }
    const result = await db.fetchTDHAbove(Number(value), includeEntries);
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
    const contract = req.params.contract;
    const id = req.params.id;
    const result = await db.fetchNfts(contract, id);
    if (contract && id) {
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

router.post('/register-prenode', async (req: Request, res: Response) => {
  const { domain, tdh, block } = req.body;

  const ip = getIp(req);

  if (!ip) {
    return res.status(400).send({ message: 'Failed to get IP address' });
  }
  if (domain === undefined) {
    return res.status(400).send({ message: 'Missing domain' });
  }
  if (!tdh) {
    return res.status(400).send({ message: 'Missing tdh' });
  }
  if (!block) {
    return res.status(400).send({ message: 'Missing block' });
  }
  if (!isValidIP(ip) && !isLocalhost(ip)) {
    return res.status(400).send('Invalid IP');
  }

  const validation = await db.validatePrenode(ip, domain, tdh, block);
  return res.status(201).send(validation);
});

router.get('/prenodes', async (req: Request, res: Response) => {
  const pageSize = getPageSize(req);
  const page = getPage(req);
  const prenodes = await db.fetchPrenodes(pageSize, page);
  return res.json(prenodes);
});
