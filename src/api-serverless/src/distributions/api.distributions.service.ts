import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  ENS_TABLE,
  MEMELAB_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE
} from '../../../constants';
import {
  AllowlistNormalizedEntry,
  Distribution
} from '../../../entities/IDistribution';
import { sqlExecutor } from '../../../sql-executor';

interface ResultsResponse {
  wallet: string;
  amount: number;
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
  const tdhResult: {
    wallets: string;
    boosted_tdh: number;
    memes_balance: number;
    unique_memes: number;
    gradients_balance: number;
  }[] = await sqlExecutor.execute(
    `SELECT wallets, boosted_tdh, memes_balance, unique_memes, gradients_balance FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );

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

  const walletTdhMap = new Map<
    string,
    {
      wallet_tdh: number;
      wallet_balance: number;
      wallet_unique_balance: number;
    }
  >();

  for (const wallet of Array.from(allWallets)) {
    const tdh = tdhResult.find((r) =>
      JSON.parse(r.wallets as any).some(
        (w: string) => wallet === w.toLowerCase()
      )
    );

    if (tdh) {
      walletTdhMap.set(wallet, {
        wallet_tdh: tdh.boosted_tdh,
        wallet_balance: tdh.memes_balance + tdh.gradients_balance,
        wallet_unique_balance: tdh.unique_memes + tdh.gradients_balance
      });
    } else {
      walletTdhMap.set(wallet, {
        wallet_tdh: 0,
        wallet_balance: 0,
        wallet_unique_balance: 0
      });
    }
  }

  const distributionInserts: Array<{
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
  }> = [];

  for (const wallet of Array.from(allWallets)) {
    const walletData = walletTdhMap.get(wallet)!;
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

  if (distributionInserts.length > 0) {
    const params: Record<string, any> = {};
    distributionInserts.forEach((dist, index) => {
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

    const placeholders = distributionInserts
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

    await sqlExecutor.execute(insertSql, params);
  }
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

    if (d.phase === 'Airdrop') {
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

    if (!dn.phases.includes(d.phase)) {
      dn.phases.push(d.phase);
    }
  }

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
