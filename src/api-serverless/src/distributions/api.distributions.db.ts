import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE
} from '@/constants';
import {
  DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES,
  DISTRIBUTION_PHASE_AIRDROP,
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import { fetchDistributionPhotosCount } from '@/api/distribution-photos/api.distribution_photos.db';
import { PaginatedResponse } from '@/api/api-constants';
import { constructFilters, getSearchFilters } from '@/api/api-helpers';
import { DistributionNormalized } from '@/api/generated/models/DistributionNormalized';
import { DistributionOverview } from '@/api/generated/models/DistributionOverview';
import { PhaseAirdrop } from '@/api/generated/models/PhaseAirdrop';
import { checkIsNormalized } from '@/api/distributions/api.distributions.service';
import { fetchPaginated } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';

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

export async function fetchDistributionAirdrops(
  contract: string,
  cardId: number
): Promise<{ wallet: string; count: number }[]> {
  return sqlExecutor.execute<{ wallet: string; count: number }>(
    `SELECT wallet, COALESCE(SUM(count), 0) AS count
     FROM ${DISTRIBUTION_TABLE}
     WHERE contract = :contract
       AND card_id = :cardId
       AND phase IN (:automaticAirdropPhases)
     GROUP BY wallet
     ORDER BY wallet ASC`,
    {
      contract: contract.toLowerCase(),
      cardId,
      automaticAirdropPhases: [...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES]
    }
  );
}

export async function fetchDistributionPhaseAirdrops(
  contract: string,
  cardId: number,
  phase:
    | typeof DISTRIBUTION_PHASE_AIRDROP_ARTIST
    | typeof DISTRIBUTION_PHASE_AIRDROP_TEAM
): Promise<PhaseAirdrop[]> {
  return sqlExecutor.execute<PhaseAirdrop>(
    `SELECT wallet, count as amount 
     FROM ${DISTRIBUTION_TABLE}
     WHERE contract = :contract
       AND card_id = :cardId
       AND phase = :phase
     ORDER BY count DESC, wallet ASC`,
    {
      contract: contract.toLowerCase(),
      cardId,
      phase
    }
  );
}

export interface PhaseDistributionData {
  phase: string;
  wallet: string;
  count_airdrop: number;
  count_allowlist: number;
}

export async function fetchDistributionsByPhase(
  contract: string,
  cardId: number
): Promise<PhaseDistributionData[]> {
  return sqlExecutor.execute<PhaseDistributionData>(
    `SELECT phase, wallet, count_airdrop, count_allowlist 
     FROM ${DISTRIBUTION_TABLE} 
     WHERE contract = :contract
       AND card_id = :cardId
       AND phase NOT IN (:automaticAirdropPhases)
     ORDER BY phase ASC, wallet ASC`,
    {
      contract: contract.toLowerCase(),
      cardId,
      automaticAirdropPhases: [...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES]
    }
  );
}

export async function fetchDistributionOverview(
  contract: string,
  cardId: number
): Promise<DistributionOverview> {
  const contractLower = contract.toLowerCase();

  const photos_count = await fetchDistributionPhotosCount(
    contractLower,
    cardId
  );

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
    artist_addresses_count: number;
    artist_total_count: number;
    team_addresses_count: number;
    team_total_count: number;
  }>(
    `SELECT
       COUNT(DISTINCT CASE WHEN phase = :artistPhase THEN wallet END) as artist_addresses_count,
       COALESCE(SUM(CASE WHEN phase = :artistPhase THEN count ELSE 0 END), 0) as artist_total_count,
       COUNT(DISTINCT CASE WHEN phase = :teamPhase THEN wallet END) as team_addresses_count,
       COALESCE(SUM(CASE WHEN phase = :teamPhase THEN count ELSE 0 END), 0) as team_total_count
     FROM ${DISTRIBUTION_TABLE}
     WHERE contract = :contract
       AND card_id = :cardId`,
    {
      contract: contractLower,
      cardId,
      artistPhase: DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      teamPhase: DISTRIBUTION_PHASE_AIRDROP_TEAM
    }
  );
  const artist_airdrops_addresses =
    automaticAirdropsResult[0]?.artist_addresses_count || 0;
  const artist_airdrops_count =
    automaticAirdropsResult[0]?.artist_total_count || 0;
  const team_airdrops_addresses =
    automaticAirdropsResult[0]?.team_addresses_count || 0;
  const team_airdrops_count = automaticAirdropsResult[0]?.team_total_count || 0;

  if (distributionPhases.size === 0) {
    return {
      photos_count,
      is_normalized: false,
      artist_airdrops_addresses,
      artist_airdrops_count,
      team_airdrops_addresses,
      team_airdrops_count
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
      artist_airdrops_addresses,
      artist_airdrops_count,
      team_airdrops_addresses,
      team_airdrops_count
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
    artist_airdrops_addresses,
    artist_airdrops_count,
    team_airdrops_addresses,
    team_airdrops_count
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
  wrappedConnection?: any,
  phase: string = DISTRIBUTION_PHASE_AIRDROP
): Promise<void> {
  await sqlExecutor.execute(
    `DELETE FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :cardId AND phase = :phase`,
    {
      contract: contract.toLowerCase(),
      cardId,
      phase
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
