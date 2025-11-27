import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { constructFilters, getSearchFilters } from '../api-helpers';
import { PaginatedResponse } from '../api-constants';
import { sqlExecutor } from '../../../sql-executor';

export async function fetchDistributionPhases(
  contract: string,
  cardId: number
): Promise<PaginatedResponse<string>> {
  const sql = `SELECT DISTINCT phase FROM ${DISTRIBUTION_TABLE} WHERE contract=:contract AND card_id=:card_id ORDER BY phase ASC`;
  const results = await sqlExecutor.execute(sql, {
    contract: contract,
    card_id: cardId
  });
  const phases = results.map((r: any) => r.phase);

  return {
    count: phases.length,
    page: 1,
    next: null,
    data: phases
  };
}

export async function fetchDistributions(
  search: string,
  cards: string,
  contracts: string,
  wallets: string,
  pageSize: number,
  page: number
): Promise<PaginatedResponse<any>> {
  if (!search && !cards && !contracts && !wallets) {
    return {
      count: 0,
      page: 1,
      next: null,
      data: []
    };
  }

  let filters = '';
  let params: any = {};

  if (search) {
    const searchFilters = getSearchFilters(
      [
        `${DISTRIBUTION_NORMALIZED_TABLE}.wallet`,
        `${DISTRIBUTION_NORMALIZED_TABLE}.wallet_display`
      ],
      search
    );
    filters = constructFilters(filters, `(${searchFilters.filters})`);
    params = {
      ...params,
      ...searchFilters.params
    };
  }
  if (cards) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_NORMALIZED_TABLE}.card_id in (:cards)`
    );
    params.cards = cards.split(',');
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_NORMALIZED_TABLE}.contract in (:contracts)`
    );
    params.contracts = contracts.split(',');
  }
  if (wallets) {
    filters = constructFilters(
      filters,
      `LOWER(${DISTRIBUTION_NORMALIZED_TABLE}.wallet) in (:wallets)`
    );
    params.wallets = wallets.split(',').map((w: string) => w.toLowerCase());
  }

  const results = await fetchPaginated(
    DISTRIBUTION_NORMALIZED_TABLE,
    params,
    `mint_date desc, airdrops desc, total_count desc, total_spots desc, wallet desc, wallet_display desc`,
    pageSize,
    page,
    filters
  );
  results.data.forEach((d: any) => {
    d.phases = JSON.parse(d.phases);
    d.allowlist = JSON.parse(d.allowlist);
  });
  return results;
}

export interface DistributionOverview {
  photos_count: number;
  is_normalized: boolean;
}

export async function fetchDistributionOverview(
  contract: string,
  cardId: number
): Promise<DistributionOverview> {
  const contractLower = contract.toLowerCase();

  const photoCountResult = await sqlExecutor.execute<{ count: number }>(
    `SELECT COUNT(*) as count FROM ${DISTRIBUTION_PHOTO_TABLE} WHERE contract = :contract AND card_id = :cardId`,
    {
      contract: contractLower,
      cardId
    }
  );
  const photos_count = photoCountResult[0]?.count || 0;

  const distributionPhasesResult = await sqlExecutor.execute<{ phase: string }>(
    `SELECT DISTINCT phase FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :cardId`,
    {
      contract: contractLower,
      cardId
    }
  );
  const distributionPhases = new Set(
    distributionPhasesResult.map((r) => r.phase)
  );

  if (distributionPhases.size === 0) {
    return {
      photos_count,
      is_normalized: false
    };
  }

  const normalizedResult = await sqlExecutor.execute<{ phases: string }>(
    `SELECT phases FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE contract = :contract AND card_id = :cardId LIMIT 1`,
    {
      contract: contractLower,
      cardId
    }
  );

  if (normalizedResult.length === 0) {
    return {
      photos_count,
      is_normalized: false
    };
  }

  const normalizedPhases = JSON.parse(normalizedResult[0].phases) as string[];
  const normalizedPhasesSet = new Set(normalizedPhases);

  const is_normalized = Array.from(distributionPhases).every((phase) =>
    normalizedPhasesSet.has(phase)
  );

  return {
    photos_count,
    is_normalized
  };
}

