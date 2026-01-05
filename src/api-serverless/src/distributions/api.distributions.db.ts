import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { sqlExecutor } from '../../../sql-executor';
import { PaginatedResponse } from '../api-constants';
import { constructFilters, getSearchFilters } from '../api-helpers';
import { DistributionNormalized } from '../generated/models/DistributionNormalized';
import { DistributionOverview } from '../generated/models/DistributionOverview';
import { checkIsNormalized } from './api.distributions.service';

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
): Promise<PaginatedResponse<DistributionNormalized>> {
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

  const automaticAirdropsResult = await sqlExecutor.execute<{
    addresses_count: number;
    total_count: number;
  }>(
    `SELECT COUNT(DISTINCT wallet) as addresses_count, COALESCE(SUM(count), 0) as total_count FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :cardId AND phase = 'Airdrop'`,
    {
      contract: contractLower,
      cardId
    }
  );
  const automatic_airdrops_addresses =
    automaticAirdropsResult[0]?.addresses_count || 0;
  const automatic_airdrops_count = automaticAirdropsResult[0]?.total_count || 0;

  if (distributionPhases.size === 0) {
    return {
      photos_count,
      is_normalized: false,
      automatic_airdrops_addresses,
      automatic_airdrops_count
    };
  }

  const normalizedResult = await sqlExecutor.execute<{ phases: string }>(
    `SELECT DISTINCT phases FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE contract = :contract AND card_id = :cardId`,
    {
      contract: contractLower,
      cardId
    }
  );

  if (normalizedResult.length === 0) {
    return {
      photos_count,
      is_normalized: false,
      automatic_airdrops_addresses,
      automatic_airdrops_count
    };
  }

  const normalizedPhasesSet = new Set<string>();
  for (const row of normalizedResult) {
    const phases = JSON.parse(row.phases) as string[];
    for (const phase of phases) {
      normalizedPhasesSet.add(phase);
    }
  }

  const is_normalized = checkIsNormalized(
    distributionPhases,
    normalizedPhasesSet
  );

  return {
    photos_count,
    is_normalized,
    automatic_airdrops_addresses,
    automatic_airdrops_count
  };
}

export interface WalletTdhData {
  wallet_tdh: number;
  wallet_balance: number;
  wallet_unique_balance: number;
}

function safeParseJson<T>(jsonString: string): T | null {
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    return null;
  }
}

export async function fetchWalletTdhData(
  wallets: string[]
): Promise<Map<string, WalletTdhData>> {
  const tdhResult: {
    wallets: string;
    boosted_tdh: number;
    memes_balance: number;
    unique_memes: number;
    gradients_balance: number;
  }[] = await sqlExecutor.execute(
    `SELECT wallets, boosted_tdh, memes_balance, unique_memes, gradients_balance FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );

  const tdhWalletMap = new Map<string, WalletTdhData>();

  for (const tdh of tdhResult) {
    const walletList = safeParseJson<string[]>(tdh.wallets as any);
    if (!walletList) {
      continue;
    }

    const tdhData: WalletTdhData = {
      wallet_tdh: tdh.boosted_tdh,
      wallet_balance: tdh.memes_balance + tdh.gradients_balance,
      wallet_unique_balance: tdh.unique_memes + tdh.gradients_balance
    };
    for (const w of walletList) {
      const walletKey = w.toLowerCase();
      if (!tdhWalletMap.has(walletKey)) {
        tdhWalletMap.set(walletKey, tdhData);
      }
    }
  }

  return tdhWalletMap;
}

export interface DistributionInsert {
  card_id: number;
  contract: string;
  phase: string;
  wallet: string;
  wallet_tdh: number;
  wallet_balance: number;
  wallet_unique_balance: number;
  count: number;
  count_airdrop: number;
  count_allowlist: number;
}

export async function deleteAirdropDistributions(
  contract: string,
  cardId: number,
  wrappedConnection?: any
): Promise<void> {
  await sqlExecutor.execute(
    `DELETE FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :cardId AND phase = 'Airdrop'`,
    {
      contract: contract.toLowerCase(),
      cardId
    },
    wrappedConnection ? { wrappedConnection } : {}
  );
}

export async function insertDistributions(
  distributions: DistributionInsert[],
  wrappedConnection?: any
): Promise<void> {
  if (distributions.length === 0) {
    return;
  }

  const params: Record<string, any> = {};
  distributions.forEach((dist, index) => {
    params[`card_id_${index}`] = dist.card_id;
    params[`contract_${index}`] = dist.contract;
    params[`phase_${index}`] = dist.phase;
    params[`wallet_${index}`] = dist.wallet;
    params[`wallet_tdh_${index}`] = dist.wallet_tdh;
    params[`wallet_balance_${index}`] = dist.wallet_balance;
    params[`wallet_unique_balance_${index}`] = dist.wallet_unique_balance;
    params[`count_${index}`] = dist.count;
    params[`count_airdrop_${index}`] = dist.count_airdrop;
    params[`count_allowlist_${index}`] = dist.count_allowlist;
  });

  const placeholders = distributions
    .map(
      (_, index) =>
        `(:card_id_${index}, :contract_${index}, :phase_${index}, :wallet_${index}, :wallet_tdh_${index}, :wallet_balance_${index}, :wallet_unique_balance_${index}, :count_${index}, :count_airdrop_${index}, :count_allowlist_${index})`
    )
    .join(', ');

  const insertSql = `
    INSERT INTO ${DISTRIBUTION_TABLE} 
      (card_id, contract, phase, wallet, wallet_tdh, wallet_balance, wallet_unique_balance, count, count_airdrop, count_allowlist)
    VALUES
      ${placeholders}
    ON DUPLICATE KEY UPDATE
      wallet_tdh = VALUES(wallet_tdh),
      wallet_balance = VALUES(wallet_balance),
      wallet_unique_balance = VALUES(wallet_unique_balance),
      count = VALUES(count),
      count_airdrop = VALUES(count_airdrop),
      count_allowlist = VALUES(count_allowlist),
      updated_at = CURRENT_TIMESTAMP(6)
  `;

  await sqlExecutor.execute(
    insertSql,
    params,
    wrappedConnection ? { wrappedConnection } : {}
  );
}
