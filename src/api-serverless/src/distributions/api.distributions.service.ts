import { computeAllowlistMerkle } from '@/api/memes-minting/allowlist-merkle';
import {
  DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES,
  DISTRIBUTION_PHASE_AIRDROP
} from '@/airdrop-phases';
import {
  deleteMintingMerkleForPhase,
  insertMintingMerkleProofs,
  insertMintingMerkleRoot
} from '@/api/memes-minting/api.memes-minting.db';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  ENS_TABLE,
  MEMELAB_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE
} from '@/constants';
import {
  AllowlistNormalizedEntry,
  Distribution
} from '../../../entities/IDistribution';
import { BadRequestException } from '../../../exceptions';
import { sqlExecutor } from '../../../sql-executor';
import {
  deleteAirdropDistributions,
  DistributionInsert,
  fetchWalletTdhData,
  insertDistributions
} from './api.distributions.db';

const automaticAirdropPhaseSet = new Set<string>(
  DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES
);

function normalizeDistributionPhase(phase: string): string {
  return automaticAirdropPhaseSet.has(phase)
    ? DISTRIBUTION_PHASE_AIRDROP
    : phase;
}

interface ResultsResponse {
  wallet: string;
  amount: number;
}

export function checkIsNormalized(
  distributionPhases: Set<string>,
  normalizedPhases: Set<string>
): boolean {
  if (distributionPhases.size === 0) {
    return false;
  }

  const canonicalDistributionPhases = new Set(
    Array.from(distributionPhases).map(normalizeDistributionPhase)
  );
  const canonicalNormalizedPhases = new Set(
    Array.from(normalizedPhases).map(normalizeDistributionPhase)
  );

  return Array.from(canonicalDistributionPhases).every((phase) =>
    canonicalNormalizedPhases.has(phase)
  );
}

function validateNormalization(
  distributions: Distribution[],
  distributionsNormalized: Map<
    string,
    {
      phases: string[];
    }
  >,
  contract: string,
  cardId: number
): void {
  const distributionPhases = new Set(
    distributions.map((d) => normalizeDistributionPhase(d.phase))
  );

  if (distributionPhases.size === 0) {
    throw new BadRequestException(
      `No distribution phases found for ${contract}#${cardId}. Cannot normalize.`
    );
  }

  const allNormalizedPhases = new Set<string>();
  for (const dn of Array.from(distributionsNormalized.values())) {
    for (const phase of dn.phases) {
      allNormalizedPhases.add(phase);
    }
  }

  const isNormalized = checkIsNormalized(
    distributionPhases,
    allNormalizedPhases
  );

  if (!isNormalized) {
    const missingPhases = Array.from(distributionPhases).filter(
      (phase) => !allNormalizedPhases.has(phase)
    );
    throw new BadRequestException(
      `Cannot normalize distribution for ${contract}#${cardId}. Missing phases in normalized data: ${missingPhases.join(', ')}`
    );
  }
}

export async function populateDistribution(
  contract: string,
  cardId: number,
  phase: string,
  splitResults: {
    airdrops: ResultsResponse[];
    airdrops_unconsolidated: ResultsResponse[];
    allowlists: ResultsResponse[];
  }
): Promise<void> {
  const walletAirdropCountMap = new Map<string, number>();
  const walletAllowlistCountMap = new Map<string, number>();
  const allWallets = new Set<string>();

  for (const airdrop of splitResults.airdrops) {
    const wallet = airdrop.wallet.toLowerCase();
    allWallets.add(wallet);
    const currentCount = walletAirdropCountMap.get(wallet) || 0;
    walletAirdropCountMap.set(wallet, currentCount + airdrop.amount);
  }

  for (const allowlist of splitResults.allowlists) {
    const wallet = allowlist.wallet.toLowerCase();
    allWallets.add(wallet);
    const currentCount = walletAllowlistCountMap.get(wallet) || 0;
    walletAllowlistCountMap.set(wallet, currentCount + allowlist.amount);
  }

  const tdhWalletMap = await fetchWalletTdhData(Array.from(allWallets));

  const distributionInserts: DistributionInsert[] = [];

  for (const wallet of Array.from(allWallets)) {
    const walletData = tdhWalletMap.get(wallet) || {
      wallet_tdh: 0,
      wallet_balance: 0,
      wallet_unique_balance: 0
    };
    const countAirdrop = walletAirdropCountMap.get(wallet) || 0;
    const countAllowlist = walletAllowlistCountMap.get(wallet) || 0;
    const count = countAirdrop + countAllowlist;

    distributionInserts.push({
      card_id: cardId,
      contract: contract.toLowerCase(),
      phase,
      wallet,
      wallet_tdh: walletData.wallet_tdh,
      wallet_balance: walletData.wallet_balance,
      wallet_unique_balance: walletData.wallet_unique_balance,
      count,
      count_airdrop: countAirdrop,
      count_allowlist: countAllowlist
    });
  }

  await insertDistributions(distributionInserts);

  const allowlistEntries = splitResults.allowlists.map((a) => ({
    address: a.wallet,
    amount: a.amount
  }));
  if (allowlistEntries.length === 0) {
    await sqlExecutor.executeNativeQueriesInTransaction(
      async (wrappedConnection) => {
        await deleteMintingMerkleForPhase(
          contract,
          cardId,
          phase,
          wrappedConnection
        );
      }
    );
    return;
  }

  const { merkleRoot, proofsByAddress } =
    computeAllowlistMerkle(allowlistEntries);
  if (!merkleRoot) return;

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      await deleteMintingMerkleForPhase(
        contract,
        cardId,
        phase,
        wrappedConnection
      );
      await insertMintingMerkleRoot(
        contract,
        cardId,
        phase,
        merkleRoot,
        wrappedConnection
      );
      await insertMintingMerkleProofs(
        merkleRoot,
        proofsByAddress,
        wrappedConnection
      );
    }
  );
}

export async function insertAutomaticAirdrops(
  contract: string,
  cardId: number,
  airdrops: Array<{ address: string; count: number }>,
  wrappedConnection?: any
): Promise<void> {
  await upsertAutomaticAirdropsForPhase(
    contract,
    cardId,
    DISTRIBUTION_PHASE_AIRDROP,
    airdrops,
    wrappedConnection,
    true
  );
}

export async function upsertAutomaticAirdropsForPhase(
  contract: string,
  cardId: number,
  phase: string,
  airdrops: Array<{ address: string; count: number }>,
  wrappedConnection?: any,
  replaceExistingPhase = false
): Promise<void> {
  if (replaceExistingPhase && wrappedConnection == null) {
    await sqlExecutor.executeNativeQueriesInTransaction(async (conn) => {
      await upsertAutomaticAirdropsForPhase(
        contract,
        cardId,
        phase,
        airdrops,
        conn,
        true
      );
    });
    return;
  }

  if (replaceExistingPhase) {
    await deleteAirdropDistributions(
      contract,
      cardId,
      wrappedConnection,
      phase
    );
  }

  if (airdrops.length === 0) {
    return;
  }

  const allWallets = new Set<string>();
  for (const airdrop of airdrops) {
    allWallets.add(airdrop.address.toLowerCase());
  }

  const tdhWalletMap = await fetchWalletTdhData(Array.from(allWallets));

  const walletCountMap = new Map<string, number>();
  for (const airdrop of airdrops) {
    const wallet = airdrop.address.toLowerCase();
    const currentCount = walletCountMap.get(wallet) || 0;
    walletCountMap.set(wallet, currentCount + airdrop.count);
  }

  const distributionInserts: DistributionInsert[] = [];

  for (const wallet of Array.from(allWallets)) {
    const tdhData = tdhWalletMap.get(wallet) || {
      wallet_tdh: 0,
      wallet_balance: 0,
      wallet_unique_balance: 0
    };
    const count = walletCountMap.get(wallet) || 0;

    distributionInserts.push({
      card_id: cardId,
      contract: contract.toLowerCase(),
      phase,
      wallet,
      wallet_tdh: tdhData.wallet_tdh,
      wallet_balance: tdhData.wallet_balance,
      wallet_unique_balance: tdhData.wallet_unique_balance,
      count,
      count_airdrop: count,
      count_allowlist: 0
    });
  }

  await insertDistributions(distributionInserts, wrappedConnection);
}

export async function populateDistributionNormalized(
  contract: string,
  cardId: number
): Promise<void> {
  const distributions: Distribution[] = await sqlExecutor.execute(
    `SELECT * FROM ${DISTRIBUTION_TABLE} WHERE card_id = :cardId AND contract = :contract`,
    {
      cardId,
      contract: contract.toLowerCase()
    }
  );

  if (distributions.length === 0) {
    throw new BadRequestException(
      `No distributions found for ${contract}#${cardId}`
    );
  }

  if (distributions.length === 0) {
    await sqlExecutor.execute(
      `DELETE FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE card_id = :cardId AND contract = :contract`,
      {
        cardId,
        contract: contract.toLowerCase()
      }
    );
    return;
  }

  const uniqueWallets = Array.from(
    new Set(distributions.map((d: Distribution) => d.wallet.toLowerCase()))
  );

  const ensResults = await sqlExecutor.execute(
    `SELECT wallet, display FROM ${ENS_TABLE} WHERE LOWER(wallet) IN (:wallets)`,
    {
      wallets: uniqueWallets
    }
  );

  const ensMap = new Map<string, string>();
  for (const ens of ensResults) {
    ensMap.set(ens.wallet.toLowerCase(), ens.display || ens.wallet);
  }

  const nftsTable =
    contract.toLowerCase() === MEMELAB_CONTRACT.toLowerCase()
      ? NFTS_MEME_LAB_TABLE
      : NFTS_TABLE;

  const nftResults = await sqlExecutor.execute(
    `SELECT name, mint_date FROM ${nftsTable} WHERE id = :cardId AND contract = :contract LIMIT 1`,
    {
      cardId,
      contract: contract.toLowerCase()
    }
  );

  const nft = nftResults[0] || null;
  const cardName = nft?.name ?? null;
  const mintDate = nft?.mint_date ?? null;

  const distributionsNormalized = new Map<
    string,
    {
      card_id: number;
      contract: string;
      wallet: string;
      wallet_display: string;
      card_name: string | null;
      mint_date: Date | null;
      airdrops: number;
      total_spots: number;
      total_count: number;
      minted: number;
      allowlist: AllowlistNormalizedEntry[];
      phases: string[];
    }
  >();

  for (const d of distributions) {
    const wallet = d.wallet.toLowerCase();
    const walletDisplay = ensMap.get(wallet) || wallet;

    let dn = distributionsNormalized.get(wallet);

    if (!dn) {
      dn = {
        card_id: cardId,
        contract: contract.toLowerCase(),
        wallet,
        wallet_display: walletDisplay,
        card_name: cardName,
        mint_date: mintDate,
        airdrops: 0,
        total_spots: 0,
        total_count: 0,
        minted: 0,
        allowlist: [],
        phases: []
      };
      distributionsNormalized.set(wallet, dn);
    }

    if (automaticAirdropPhaseSet.has(d.phase)) {
      dn.airdrops += d.count;
      dn.total_count += d.count;
    } else {
      const dPhase: AllowlistNormalizedEntry = {
        phase: d.phase,
        spots: d.count,
        spots_airdrop: d.count_airdrop || 0,
        spots_allowlist: d.count_allowlist || 0
      };
      dn.allowlist.push(dPhase);
      dn.total_spots += d.count;
    }

    const normalizedPhase = normalizeDistributionPhase(d.phase);
    if (!dn.phases.includes(normalizedPhase)) {
      dn.phases.push(normalizedPhase);
    }
  }

  validateNormalization(
    distributions,
    distributionsNormalized,
    contract,
    cardId
  );

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE card_id = :cardId AND contract = :contract`,
        {
          cardId,
          contract: contract.toLowerCase()
        },
        { wrappedConnection }
      );

      if (distributionsNormalized.size > 0) {
        const normalizedArray = Array.from(distributionsNormalized.values());
        const params: Record<string, any> = {};
        const placeholders = normalizedArray
          .map(
            (_, index) =>
              `(:card_id_${index}, :contract_${index}, :wallet_${index}, :wallet_display_${index}, :card_name_${index}, :mint_date_${index}, :airdrops_${index}, :total_spots_${index}, :total_count_${index}, :minted_${index}, :allowlist_${index}, :phases_${index})`
          )
          .join(', ');

        normalizedArray.forEach((dn, index) => {
          params[`card_id_${index}`] = dn.card_id;
          params[`contract_${index}`] = dn.contract;
          params[`wallet_${index}`] = dn.wallet;
          params[`wallet_display_${index}`] = dn.wallet_display;
          params[`card_name_${index}`] = dn.card_name;
          params[`mint_date_${index}`] = dn.mint_date;
          params[`airdrops_${index}`] = dn.airdrops;
          params[`total_spots_${index}`] = dn.total_spots;
          params[`total_count_${index}`] = dn.total_count;
          params[`minted_${index}`] = dn.minted;
          params[`allowlist_${index}`] = JSON.stringify(dn.allowlist);
          params[`phases_${index}`] = JSON.stringify(dn.phases);
        });

        const insertSql = `
          INSERT INTO ${DISTRIBUTION_NORMALIZED_TABLE} 
            (card_id, contract, wallet, wallet_display, card_name, mint_date, airdrops, total_spots, total_count, minted, allowlist, phases)
          VALUES
            ${placeholders}
        `;

        await sqlExecutor.execute(insertSql, params, {
          wrappedConnection
        });
      }
    }
  );
}
