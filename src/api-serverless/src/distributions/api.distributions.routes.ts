import { ethers } from 'ethers';
import { Request, Response } from 'express';
import {
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import { DISTRIBUTION_PAGE_SIZE } from '@/api/api-constants';
import {
  getPage,
  getPageSize,
  giveReadReplicaTimeToCatchUp,
  returnCSVResult,
  returnPaginatedResult
} from '@/api/api-helpers';
import { asyncRouter } from '@/api/async.router';
import { needsAuthenticatedUser } from '@/api/auth/auth';
import { cacheRequest } from '@/api/request-cache';
import { authenticateSubscriptionsAdmin } from '@/api/subscriptions/api.subscriptions.allowlist';
import { ForbiddenException } from '@/exceptions';
import { numbers } from '@/numbers';
import { evictRedisCacheForPathWithTimeout } from '@/redis';
import { Logger } from '@/logging';
import {
  fetchDistributionPhaseAirdrops,
  fetchDistributionOverview,
  fetchDistributionPhases,
  fetchDistributions
} from '@/api/distributions/api.distributions.db';
import {
  insertAutomaticAirdropsForPhase,
  populateDistributionNormalized
} from '@/api/distributions/api.distributions.service';
import { githubDistributionService } from '@/api/distributions/github-distribution.service';

interface AirdropEntry {
  address: string;
  count: number;
}

class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

function parseAirdropCsv(csvData: string): AirdropEntry[] {
  const airdrops: AirdropEntry[] = [];
  const lines = csvData.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(',');
    const lineNum = i + 1;

    if (parts.length !== 2) {
      throw new CsvParseError(
        `Invalid CSV format at line ${lineNum}: expected 2 columns, got ${parts.length}`
      );
    }

    const address = parts[0]?.trim();
    const countStr = parts[1]?.trim();
    const count = numbers.parseIntOrNull(countStr);

    if (!address) {
      throw new CsvParseError(
        `Invalid CSV format at line ${lineNum}: address is empty`
      );
    }

    if (!ethers.isAddress(address)) {
      throw new CsvParseError(
        `Invalid CSV format at line ${lineNum}: "${address}" is not a valid Ethereum address`
      );
    }

    if (count === null) {
      throw new CsvParseError(
        `Invalid CSV format at line ${lineNum}: count "${countStr}" is not a valid number`
      );
    }

    if (count <= 0) {
      throw new CsvParseError(
        `Invalid CSV format at line ${lineNum}: count must be greater than 0, got ${count}`
      );
    }

    airdrops.push({ address, count });
  }

  if (airdrops.length === 0) {
    throw new CsvParseError('No valid airdrop entries found in CSV');
  }

  return airdrops;
}

const router = asyncRouter();
const logger = Logger.get('DISTRIBUTIONS');
const CACHE_EVICTION_TIMEOUT_MS = 1_500;

async function evictDistributionCacheForPathWithTimeout(
  contract: string,
  cardId: number,
  cacheEviction: {
    label: string;
    path: string;
  }
) {
  const evictionResult = await evictRedisCacheForPathWithTimeout({
    path: cacheEviction.path,
    timeoutMs: CACHE_EVICTION_TIMEOUT_MS
  });

  if (evictionResult.success) {
    logger.info(
      `[CACHE_EVICT_DONE] [contract ${contract}] [card_id ${cardId}] [cache ${cacheEviction.label}] [elapsed_ms ${
        evictionResult.elapsed_ms
      }]`
    );
  } else {
    logger.warn(
      `[CACHE_EVICT_FAILED] [contract ${contract}] [card_id ${cardId}] [cache ${cacheEviction.label}] [elapsed_ms ${
        evictionResult.elapsed_ms
      }]`,
      'error' in evictionResult ? evictionResult.error : undefined
    );
  }
}

async function invalidateDistributionOverviewCache(
  contract: string,
  cardId: number
) {
  await giveReadReplicaTimeToCatchUp();
  await Promise.allSettled([
    evictDistributionCacheForPathWithTimeout(contract, cardId, {
      label: 'distribution-overview',
      path: `/api/distributions/${contract}/${cardId}/overview`
    })
  ]);
}

function validateSubscriptionAdminAndParams(
  req: Request<any, any, any, any>,
  res: Response
): { contract: string; cardId: number } | null {
  const authenticated = authenticateSubscriptionsAdmin(req);
  if (!authenticated) {
    throw new ForbiddenException(
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

async function uploadAutomaticAirdropsForPhase(
  req: Request<any, any, any, any>,
  res: Response,
  phase:
    | typeof DISTRIBUTION_PHASE_AIRDROP_ARTIST
    | typeof DISTRIBUTION_PHASE_AIRDROP_TEAM,
  uploadLabel: string
): Promise<void> {
  const params = validateSubscriptionAdminAndParams(req, res);
  if (!params) {
    return;
  }
  const { contract, cardId } = params;

  const { csv: csvData } = req.body;
  if (!csvData || typeof csvData !== 'string') {
    res.status(400).send({
      success: false,
      error: 'CSV data is required in request body'
    });
    return;
  }

  let airdrops: AirdropEntry[];
  try {
    airdrops = parseAirdropCsv(csvData);
  } catch (e) {
    if (e instanceof CsvParseError) {
      res.status(400).send({
        success: false,
        error: e.message
      });
      return;
    }
    throw e;
  }

  await insertAutomaticAirdropsForPhase(contract, cardId, phase, airdrops);

  await invalidateDistributionOverviewCache(contract, cardId);

  res.json({
    success: true,
    message: `Successfully uploaded ${uploadLabel}`
  });
}

async function downloadAutomaticAirdropsForPhase(
  req: Request<any, any, any, any>,
  res: Response,
  phase:
    | typeof DISTRIBUTION_PHASE_AIRDROP_ARTIST
    | typeof DISTRIBUTION_PHASE_AIRDROP_TEAM,
  filenamePrefix: string
): Promise<void> {
  const params = validateSubscriptionAdminAndParams(req, res);
  if (!params) {
    return;
  }
  const { contract, cardId } = params;

  const airdrops = await fetchDistributionPhaseAirdrops(
    contract,
    cardId,
    phase
  );
  const sortedAirdrops = [...airdrops].sort(
    (a, b) => b.amount - a.amount || a.wallet.localeCompare(b.wallet)
  );

  res.vary('Accept');

  const acceptHeader = req.get('accept')?.toLowerCase() ?? '';
  if (acceptHeader.includes('text/csv')) {
    await returnCSVResult(
      `${filenamePrefix}_${cardId}`,
      sortedAirdrops.map((airdrop) => ({
        address: airdrop.wallet,
        count: airdrop.amount
      })),
      res
    );
    return;
  }

  res.json(sortedAirdrops);
}

router.get(
  `/distribution_phases/:contract/:nft_id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;

    await fetchDistributionPhases(contract, nftId).then((result) => {
      return returnPaginatedResult(result, req, res);
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
    ).then((result) => {
      return returnPaginatedResult(result, req, res);
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
      throw new ForbiddenException(
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
    return res.json(overview);
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

    await invalidateDistributionOverviewCache(contract, cardId);

    return res.json({
      success: true,
      message: 'Distribution normalized successfully'
    });
  }
);

router.post(
  `/distributions/:contract/:id/artist-airdrops`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    await uploadAutomaticAirdropsForPhase(
      req,
      res,
      DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      'artist airdrops'
    );
  }
);

router.get(
  `/distributions/:contract/:id/artist-airdrops`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    await downloadAutomaticAirdropsForPhase(
      req,
      res,
      DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      'artist_airdrops'
    );
  }
);

router.post(
  `/distributions/:contract/:id/team-airdrops`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    await uploadAutomaticAirdropsForPhase(
      req,
      res,
      DISTRIBUTION_PHASE_AIRDROP_TEAM,
      'team airdrops'
    );
  }
);

router.get(
  `/distributions/:contract/:id/team-airdrops`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    await downloadAutomaticAirdropsForPhase(
      req,
      res,
      DISTRIBUTION_PHASE_AIRDROP_TEAM,
      'team_airdrops'
    );
  }
);

router.post(
  `/distributions/:contract/:id/github-upload`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    const params = validateSubscriptionAdminAndParams(req, res);
    if (!params) {
      return;
    }
    const { contract, cardId } = params;
    const result = await githubDistributionService.uploadDistributionForCard(
      contract,
      cardId
    );
    res.json(result);
  }
);

export default router;
