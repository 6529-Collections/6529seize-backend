import { RequestContext } from '@/request.context';
import { computeAllowlistMerkle } from '@/api/minting-claims/allowlist-merkle';
import {
  DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES,
  DISTRIBUTION_PHASE_AIRDROP,
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import {
  deleteMintingMerkleForPhase,
  insertMintingMerkleProofs,
  insertMintingMerkleRoot
} from '@/api/minting-claims/api.minting-claims.db';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  ENS_TABLE,
  MEMELAB_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE
} from '@/constants';
import {
  deleteAirdropDistributions,
  DistributionInsert,
  fetchWalletTdhData,
  insertDistributions
} from '@/api/distributions/api.distributions.db';
import { BadRequestException } from '@/exceptions';
import {
  AllowlistNormalizedEntry,
  Distribution
} from '@/entities/IDistribution';
import { sqlExecutor } from '@/sql-executor';

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
  },
  ctx: RequestContext = {}
): Promise<void> {
  if (!ctx.connection) {
    return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      populateDistribution(contract, cardId, phase, splitResults, {
        ...ctx,
        connection
      })
    );
  }
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

  const tdhWalletMap = await fetchWalletTdhData(Array.from(allWallets), ctx);

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

  await insertDistributions(distributionInserts, ctx.connection);

  const allowlistEntries = splitResults.allowlists.map((a) => ({
    address: a.wallet,
    amount: a.amount
  }));
  await deleteMintingMerkleForPhase(contract, cardId, phase, ctx.connection);
  if (!allowlistEntries.length) return;
  const { merkleRoot, proofsByAddress } =
    computeAllowlistMerkle(allowlistEntries);
  if (!merkleRoot) return;
  await insertMintingMerkleRoot(
    contract,
    cardId,
    phase,
    merkleRoot,
    ctx.connection
  );
  await insertMintingMerkleProofs(merkleRoot, proofsByAddress, ctx.connection);
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

export async function insertAutomaticAirdropsForPhase(
  contract: string,
  cardId: number,
  phase:
    | typeof DISTRIBUTION_PHASE_AIRDROP
    | typeof DISTRIBUTION_PHASE_AIRDROP_ARTIST
    | typeof DISTRIBUTION_PHASE_AIRDROP_TEAM,
  airdrops: Array<{ address: string; count: number }>,
  wrappedConnection?: any
): Promise<void> {
  await upsertAutomaticAirdropsForPhase(
    contract,
    cardId,
    phase,
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
  cardId: number,
  ctx: RequestContext = {}
): Promise<void> {
  if (!ctx.connection) {
    return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      populateDistributionNormalized(contract, cardId, { ...ctx, connection })
    );
  }
  const distributions: Distribution[] = await sqlExecutor.execute(
    `SELECT * FROM ${DISTRIBUTION_TABLE} WHERE card_id = :cardId AND contract = :contract`,
    {
      cardId,
      contract: contract.toLowerCase()
    },
    { wrappedConnection: ctx.connection }
  );

  if (distributions.length === 0) {
    throw new BadRequestException(
      `No distributions found for ${contract}#${cardId}`
    );
  }

  const uniqueWallets = Array.from(
    new Set(distributions.map((d: Distribution) => d.wallet.toLowerCase()))
  );

  const ensResults = await sqlExecutor.execute(
    `SELECT wallet, display FROM ${ENS_TABLE} WHERE LOWER(wallet) IN (:wallets)`,
    {
      wallets: uniqueWallets
    },
    { wrappedConnection: ctx.connection }
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
    },
    { wrappedConnection: ctx.connection }
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

  await sqlExecutor.execute(
    `DELETE FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE card_id = :cardId AND contract = :contract`,
    { cardId, contract: contract.toLowerCase() },
    { wrappedConnection: ctx.connection }
  );
  const rows = Array.from(distributionsNormalized.values()).map((row) => ({
    ...row,
    allowlist: JSON.stringify(row.allowlist),
    phases: JSON.stringify(row.phases)
  }));
  await sqlExecutor.bulkInsert(
    DISTRIBUTION_NORMALIZED_TABLE,
    rows,
    [
      'card_id',
      'contract',
      'wallet',
      'wallet_display',
      'card_name',
      'mint_date',
      'airdrops',
      'total_spots',
      'total_count',
      'minted',
      'allowlist',
      'phases'
    ],
    ctx,
    { chunkSize: 500 }
  );
}
