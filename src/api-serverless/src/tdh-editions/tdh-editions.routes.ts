import { Request } from 'express';
import { UUID_REGEX, WALLET_REGEX } from '../../../constants';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { identitiesDb } from '../../../identities/identities.db';
import { numbers } from '../../../numbers';
import { Timer } from '../../../time';
import {
  getPage,
  getPageSize,
  resolveSortDirection,
  returnPaginatedResult
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import {
  DEFAULT_TDH_EDITION_SORT,
  fetchConsolidatedTdhEditions,
  fetchIdentityTdhEditions,
  fetchWalletTdhEditions,
  IdentityFilterType,
  TDH_EDITION_SORT_MAP,
  TdhEditionFilters
} from './tdh-editions.db';

const router = asyncRouter();

export default router;

const SORT_FIELDS = Object.keys(TDH_EDITION_SORT_MAP);

function resolveSort(sort?: string | null) {
  if (!sort) {
    return DEFAULT_TDH_EDITION_SORT;
  }
  const key = sort.toLowerCase();
  return SORT_FIELDS.includes(key) ? key : DEFAULT_TDH_EDITION_SORT;
}

function parseFilters(query: Request['query']): TdhEditionFilters {
  const contract =
    typeof query.contract === 'string'
      ? query.contract.toLowerCase()
      : undefined;
  const tokenId = numbers.parseIntOrNull(query.token_id);
  const editionId = numbers.parseIntOrNull(query.edition_id);

  return {
    contract,
    tokenId: tokenId === null ? undefined : tokenId,
    editionId: editionId === null ? undefined : editionId
  };
}

router.get('/wallet/:wallet', async (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  if (!WALLET_REGEX.test(wallet)) {
    throw new BadRequestException(`Invalid wallet ${wallet}`);
  }
  const page = getPage(req);
  const pageSize = getPageSize(req);
  const sort = resolveSort(req.query.sort as string | undefined);
  const sortDir = resolveSortDirection(req.query.sort_direction);
  const filters = parseFilters(req.query);

  const result = await fetchWalletTdhEditions(
    wallet,
    sort,
    sortDir,
    page,
    pageSize,
    filters
  );
  await returnPaginatedResult(result, req, res);
});

router.get('/consolidation/:consolidation_key', async (req, res) => {
  const consolidationKey = req.params.consolidation_key.toLowerCase();
  const page = getPage(req);
  const pageSize = getPageSize(req);
  const sort = resolveSort(req.query.sort as string | undefined);
  const sortDir = resolveSortDirection(req.query.sort_direction);
  const filters = parseFilters(req.query);

  const result = await fetchConsolidatedTdhEditions(
    consolidationKey,
    sort,
    sortDir,
    page,
    pageSize,
    filters
  );
  await returnPaginatedResult(result, req, res);
});

router.get('/identity/:identity', async (req, res) => {
  const identityParam = req.params.identity;
  const timer = Timer.getFromRequest(req);
  const filterType = UUID_REGEX.test(identityParam)
    ? IdentityFilterType.PROFILE_ID
    : IdentityFilterType.HANDLE;

  const identityRecord =
    filterType === IdentityFilterType.PROFILE_ID
      ? await identitiesDb.getIdentityByProfileId(identityParam)
      : await identitiesDb.getIdentityByHandle(identityParam, { timer });

  if (!identityRecord) {
    throw new NotFoundException(`Identity ${identityParam} not found`);
  }

  const identityValue =
    filterType === IdentityFilterType.PROFILE_ID
      ? identityRecord.profile_id!
      : (identityRecord.normalised_handle ??
        identityRecord.handle?.toLowerCase());

  if (!identityValue) {
    throw new NotFoundException(`Identity ${identityParam} not found`);
  }

  const page = getPage(req);
  const pageSize = getPageSize(req);
  const sort = resolveSort(req.query.sort as string | undefined);
  const sortDir = resolveSortDirection(req.query.sort_direction);
  const filters = parseFilters(req.query);

  const result = await fetchIdentityTdhEditions(
    identityValue,
    filterType,
    sort,
    sortDir,
    page,
    pageSize,
    filters
  );
  await returnPaginatedResult(result, req, res);
});
