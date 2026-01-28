import { ethers } from 'ethers';
import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { Logger } from '../../../logging';
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
  fetchDistributions,
  fetchDistributionPhotos,
  fetchDistributionAirdrops,
  fetchDistributionsByPhase,
  PhaseDistributionData
} from './api.distributions.db';
import {
  insertAutomaticAirdrops,
  populateDistributionNormalized
} from './api.distributions.service';
import { githubDistributionService } from './github-distribution.service';

const logger = Logger.get('DISTRIBUTIONS_ROUTES');

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

    let airdrops: AirdropEntry[];
    try {
      airdrops = parseAirdropCsv(csvData);
    } catch (e) {
      if (e instanceof CsvParseError) {
        return res.status(400).send({
          success: false,
          error: e.message
        });
      }
      throw e;
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

function getFileExtensionFromUrl(url: string): string {
  const urlPath = new URL(url).pathname;
  const lastDot = urlPath.lastIndexOf('.');
  if (lastDot === -1) {
    return 'jpg';
  }
  return urlPath.substring(lastDot + 1).toLowerCase();
}

interface PhaseCsvFiles {
  phaseIndex: number;
  phaseName: string;
  airdropsCsv: string;
  allowlistsCsv: string;
}

function buildPhaseCsvFiles(
  phaseData: PhaseDistributionData[]
): PhaseCsvFiles[] {
  const phaseMap = new Map<
    string,
    { airdrops: Map<string, number>; allowlists: Map<string, number> }
  >();

  for (const row of phaseData) {
    let phase = phaseMap.get(row.phase);
    if (!phase) {
      phase = { airdrops: new Map(), allowlists: new Map() };
      phaseMap.set(row.phase, phase);
    }

    if (row.count_airdrop > 0) {
      const current = phase.airdrops.get(row.wallet) || 0;
      phase.airdrops.set(row.wallet, current + row.count_airdrop);
    }
    if (row.count_allowlist > 0) {
      const current = phase.allowlists.get(row.wallet) || 0;
      phase.allowlists.set(row.wallet, current + row.count_allowlist);
    }
  }

  const sortedPhases = Array.from(phaseMap.keys()).sort();
  const result: PhaseCsvFiles[] = [];

  for (let i = 0; i < sortedPhases.length; i++) {
    const phaseName = sortedPhases[i];
    const phase = phaseMap.get(phaseName)!;

    const airdropLines: string[] = [];
    const sortedAirdrops = Array.from(phase.airdrops.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    for (const [wallet, count] of sortedAirdrops) {
      airdropLines.push(`${wallet},${count}`);
    }

    const allowlistLines: string[] = [];
    const sortedAllowlists = Array.from(phase.allowlists.entries()).sort(
      (a, b) => a[0].localeCompare(b[0])
    );
    for (const [wallet, count] of sortedAllowlists) {
      allowlistLines.push(`${wallet},${count}`);
    }

    result.push({
      phaseIndex: i,
      phaseName,
      airdropsCsv: airdropLines.join('\n'),
      allowlistsCsv: allowlistLines.join('\n')
    });
  }

  return result;
}

router.post(
  `/distributions/:contract/:id/github-upload`,
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    const params = validateSubscriptionAdminAndParams(req, res);
    if (!params) {
      return;
    }
    const { contract, cardId } = params;

    const overview = await fetchDistributionOverview(contract, cardId);
    if (!overview.is_normalized) {
      throw new BadRequestException(
        `Cannot upload to GitHub: Distribution for ${contract}#${cardId} is not normalized. Please call /normalize first.`
      );
    }

    const photos = await fetchDistributionPhotos(contract, cardId);
    if (photos.length === 0) {
      throw new BadRequestException(
        `Cannot upload to GitHub: No photos found for ${contract}#${cardId}. Please upload photos first.`
      );
    }

    const airdrops = await fetchDistributionAirdrops(contract, cardId);
    if (airdrops.length === 0) {
      throw new BadRequestException(
        `Cannot upload to GitHub: No automatic airdrops found for ${contract}#${cardId}. Please upload airdrops first.`
      );
    }

    const phaseData = await fetchDistributionsByPhase(contract, cardId);

    logger.info(
      `GitHub upload for ${contract}#${cardId}: ${photos.length} photos, ${airdrops.length} airdrop entries, ${phaseData.length} phase distribution rows`
    );

    const photoBuffers: { fileName: string; content: Buffer }[] = [];
    for (let i = 0; i < photos.length; i++) {
      const photoUrl = photos[i].link;
      const extension = getFileExtensionFromUrl(photoUrl);
      const fileName = `card${cardId}_${i + 1}.${extension}`;

      logger.info(`Fetching photo ${i + 1}/${photos.length}: ${photoUrl}`);
      const photoResp = await fetch(photoUrl);
      if (!photoResp.ok) {
        throw new BadRequestException(
          `Failed to fetch photo from ${photoUrl}: ${photoResp.status} ${photoResp.statusText}`
        );
      }
      const buffer = Buffer.from(await photoResp.arrayBuffer());
      photoBuffers.push({ fileName, content: buffer });
    }

    const airdropLines: string[] = [];
    for (const airdrop of airdrops) {
      airdropLines.push(`${airdrop.wallet},${airdrop.count}`);
    }
    const airdropFinalCsv = airdropLines.join('\n');

    const phaseCsvFiles = buildPhaseCsvFiles(phaseData);

    logger.info(
      `Uploading to GitHub for card${cardId} (will replace existing folder)...`
    );
    const { uploadedFiles, deletedFiles } =
      await githubDistributionService.uploadDistributionFiles(
        cardId,
        photoBuffers,
        airdropFinalCsv,
        phaseCsvFiles
      );

    logger.info(
      `GitHub upload complete for ${contract}#${cardId}. Deleted ${deletedFiles.length} files, uploaded ${uploadedFiles.length} files.`
    );

    return await returnJsonResult(
      {
        success: true,
        message: `Distribution uploaded to GitHub`,
        github_folder: `card${cardId}`,
        deleted_files: deletedFiles,
        uploaded_files: uploadedFiles
      },
      req,
      res
    );
  }
);

export default router;
