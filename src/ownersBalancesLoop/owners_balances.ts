import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '../constants';
import { Owner } from '../entities/IOwner';
import { areEqualAddresses } from '../helpers';
import {
  fetchAllConsolidatedOwnerBalances,
  fetchAllConsolidatedOwnerBalancesMemes,
  fetchAllOwnerBalances,
  fetchAllOwnerBalancesMemes,
  persistOwnerBalances,
  persistConsolidatedOwnerBalances
} from './db.owners_balances';
import {
  fetchAllOwners,
  fetchAllSeasons,
  fetchWalletConsolidationKeysView
} from '../db';
import { Logger } from '../logging';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { MemesSeason } from '../entities/ISeason';

const logger = Logger.get('OWNER_BALANCES_LOOP');

export const findOwnerBalances = async (reset?: boolean) => {
  const startingOwners: Owner[] = await fetchAllOwners();
  const startingBalances: OwnerBalances[] = await fetchAllOwnerBalances();
  const startingBalancesMemes: OwnerBalancesMemes[] =
    await fetchAllOwnerBalancesMemes();
  const seasons: MemesSeason[] = await fetchAllSeasons();

  const uniqueOwnerWallets = new Set<string>();
  [...startingOwners].forEach((o) => {
    uniqueOwnerWallets.add(o.wallet.toLowerCase());
  });

  logger.info({
    owner_balances: startingBalances.length.toLocaleString(),
    owner_balances_memes: startingBalancesMemes.length.toLocaleString(),
    owners: startingOwners.length.toLocaleString(),
    unique_owners: uniqueOwnerWallets.size.toLocaleString()
  });

  const ownersBalancesDelta: OwnerBalances[] = [];
  const ownersBalancesMemesDelta: OwnerBalancesMemes[] = [];

  uniqueOwnerWallets.forEach((owner) => {
    const owned = [...startingOwners].filter((o) =>
      areEqualAddresses(o.wallet, owner)
    );

    const oBalance = buildBalances(owned, seasons, startingBalances);
    if (oBalance) {
      ownersBalancesDelta.push(oBalance);
    }

    const oBalancesSeasons = buildSeasonBalances(
      owned,
      seasons,
      startingBalancesMemes
    );
    ownersBalancesMemesDelta.push(...oBalancesSeasons);
  });

  startingBalances.forEach((sb) => {
    if (!uniqueOwnerWallets.has(sb.wallet)) {
      ownersBalancesDelta.push({
        ...sb,
        total_balance: 0
      });
    }
  });

  startingBalancesMemes.forEach((sb) => {
    if (!uniqueOwnerWallets.has(sb.wallet)) {
      ownersBalancesMemesDelta.push({
        ...sb,
        balance: 0
      });
    }
  });

  await persistOwnerBalances(ownersBalancesDelta, ownersBalancesMemesDelta);

  return {
    ownersBalances: ownersBalancesDelta,
    ownersBalancesMemes: ownersBalancesMemesDelta
  };
};

function buildBalances(
  owned: Owner[],
  seasons: MemesSeason[],
  startingBalances: OwnerBalances[]
) {
  const walletMemes = [...owned].filter((n) =>
    areEqualAddresses(n.contract, MEMES_CONTRACT)
  );
  const walletMemesGenesis = [...walletMemes].filter(
    (a) => a.token_id == 1 || a.token_id == 2 || a.token_id == 3
  );
  const walletMemesNaka = [...walletMemes].filter((a) => a.token_id == 4);

  const walletGradients = [...owned].filter((n) =>
    areEqualAddresses(n.contract, GRADIENT_CONTRACT)
  );

  const maxSeasonIndex = Math.max(...[...seasons].map((s) => s.end_index));

  let memesCardSets = 0;
  let memesCardSetsMinus1 = 0;
  let memesCardSetsMinus2 = 0;
  let walletMemesSet1: any[] = [];
  let walletMemesSet2: any[] = [];
  if (walletMemes.length == maxSeasonIndex) {
    memesCardSets = Math.min.apply(
      Math,
      [...walletMemes].map(function (o) {
        return o.balance;
      })
    );
    walletMemesSet1 = [...walletMemes].filter((n) => n.balance > memesCardSets);
  } else {
    walletMemesSet1 = [...walletMemes];
  }
  if (walletMemesSet1.length == maxSeasonIndex - 1) {
    memesCardSetsMinus1 =
      Math.min.apply(
        Math,
        [...walletMemesSet1].map(function (o) {
          return o.balance;
        })
      ) - memesCardSets;
    walletMemesSet2 = [...walletMemesSet1].filter(
      (n) => n.balance > memesCardSetsMinus1
    );
  } else {
    walletMemesSet2 = [...walletMemesSet1];
  }
  if (walletMemesSet2.length == maxSeasonIndex - 2) {
    memesCardSetsMinus2 =
      Math.min.apply(
        Math,
        [...walletMemesSet2].map(function (o) {
          return o.balance;
        })
      ) - memesCardSetsMinus1;
  }

  const memesNftsGenesis = [1, 2, 3];
  let genesis = 0;
  if (walletMemesGenesis.length == memesNftsGenesis.length) {
    genesis = Math.min.apply(
      Math,
      [...walletMemesGenesis].map(function (o) {
        return o.balance;
      })
    );
  }

  let nakamoto = 0;
  if (walletMemesNaka.length > 0) {
    nakamoto = Math.min.apply(
      Math,
      [...walletMemesNaka].map(function (o) {
        return o.balance;
      })
    );
  }

  let memesBalance = 0;
  walletMemes.forEach((a) => {
    memesBalance += a.balance;
  });

  const wallet = owned[0].wallet;

  const oBalance: OwnerBalances = {
    wallet: wallet.toLowerCase(),
    total_balance: memesBalance + walletGradients.length,
    gradients_balance: walletGradients.length,
    memes_balance: memesBalance,
    unique_memes: walletMemes.length,
    genesis: genesis,
    nakamoto: nakamoto,
    memes_cards_sets: memesCardSets,
    memes_cards_sets_minus1: memesCardSetsMinus1,
    memes_cards_sets_minus2: memesCardSetsMinus2
  };

  const existingBalances = startingBalances.find((o) =>
    areEqualAddresses(o.wallet, wallet)
  );
  if (existingBalances) {
    if (
      existingBalances.genesis != oBalance.genesis ||
      existingBalances.nakamoto != oBalance.nakamoto ||
      existingBalances.memes_balance != oBalance.memes_balance ||
      existingBalances.gradients_balance != oBalance.gradients_balance ||
      existingBalances.unique_memes != oBalance.unique_memes ||
      existingBalances.memes_cards_sets != oBalance.memes_cards_sets ||
      existingBalances.memes_cards_sets_minus1 !=
        oBalance.memes_cards_sets_minus1 ||
      existingBalances.memes_cards_sets_minus2 !=
        oBalance.memes_cards_sets_minus2
    ) {
      return oBalance;
    }
  } else {
    return oBalance;
  }

  return null;
}

function buildSeasonBalances(
  owned: Owner[],
  seasons: MemesSeason[],
  startingBalances: OwnerBalancesMemes[]
) {
  const walletMemes = [...owned].filter((n) =>
    areEqualAddresses(n.contract, MEMES_CONTRACT)
  );

  const seasonMemes = new Map<number, Owner[]>();
  seasons.forEach((s) => {
    const seasonOwned = walletMemes.filter(
      (n) => n.token_id >= s.start_index && n.token_id <= s.end_index
    );
    seasonMemes.set(s.id, seasonOwned);
  });

  const wallet = owned[0].wallet;

  const seasonBalances: OwnerBalancesMemes[] = [];
  seasonMemes.forEach((owners, seasonId) => {
    let seasonBalance = 0;
    owners.forEach((o) => (seasonBalance += o.balance));

    if (seasonBalance > 0) {
      const seasonSets = Math.min.apply(
        Math,
        [...owners].map(function (o) {
          return o.balance;
        })
      );

      const oBalanceMemes: OwnerBalancesMemes = {
        wallet: wallet.toLowerCase(),
        season: seasonId,
        balance: seasonBalance,
        unique: owners.length,
        sets: seasonSets
      };

      const existingBalances = startingBalances.find(
        (o) => areEqualAddresses(o.wallet, wallet) && o.season === seasonId
      );
      if (existingBalances) {
        if (
          existingBalances.balance != oBalanceMemes.balance ||
          existingBalances.unique != oBalanceMemes.unique ||
          existingBalances.sets != oBalanceMemes.sets
        ) {
          seasonBalances.push(oBalanceMemes);
        }
      } else {
        seasonBalances.push(oBalanceMemes);
      }
    }
  });

  return seasonBalances;
}

export async function consolidateOwnerBalances() {
  const walletConsolidations = await fetchWalletConsolidationKeysView();

  const ownersBalances: OwnerBalances[] = await fetchAllOwnerBalances();
  const ownersBalancesMemes: OwnerBalancesMemes[] =
    await fetchAllOwnerBalancesMemes();

  const startingConsolidatedOwnersBalances =
    await fetchAllConsolidatedOwnerBalances();

  const startingConsolidatedOwnersBalancesMemes =
    await fetchAllConsolidatedOwnerBalancesMemes();

  const consolidatedOwnersBalances: ConsolidatedOwnerBalances[] = [];
  const consolidatedOwnersBalancesMemes: ConsolidatedOwnerBalancesMemes[] = [];

  const usedOwnerBalances = new Set<string>();
  ownersBalances.forEach((ob) => {
    const walletKey = ob.wallet.toLowerCase();
    if (usedOwnerBalances.has(walletKey)) {
      return;
    }

    const consolidation = walletConsolidations.find((wc) =>
      wc.consolidation_key.includes(walletKey)
    );

    if (!consolidation) {
      const consolidatedOwnerBalance: ConsolidatedOwnerBalances = {
        ...ob,
        consolidation_key: walletKey
      };
      consolidatedOwnersBalances.push(consolidatedOwnerBalance);
      usedOwnerBalances.add(walletKey);
    } else {
      const consolidationBalances = ownersBalances.filter((oob) =>
        consolidation.consolidation_key.includes(oob.wallet.toLowerCase())
      );
      if (consolidationBalances.length > 0) {
        const totals = consolidationBalances.reduce(
          (acc, cp) => {
            acc.total_balance += cp.total_balance;
            acc.gradients_balance += cp.gradients_balance;
            acc.memes_balance += cp.memes_balance;
            acc.unique_memes += cp.unique_memes;
            acc.genesis += cp.genesis;
            acc.nakamoto += cp.nakamoto;
            acc.memes_cards_sets += cp.memes_cards_sets;
            acc.memes_cards_sets_minus1 += cp.memes_cards_sets_minus1;
            acc.memes_cards_sets_minus2 += cp.memes_cards_sets_minus2;

            return acc;
          },
          {
            total_balance: 0,
            gradients_balance: 0,
            memes_balance: 0,
            unique_memes: 0,
            genesis: 0,
            nakamoto: 0,
            memes_cards_sets: 0,
            memes_cards_sets_minus1: 0,
            memes_cards_sets_minus2: 0
          }
        );
        const cBalance: ConsolidatedOwnerBalances = {
          consolidation_key: consolidation.consolidation_key,
          ...totals
        };
        consolidatedOwnersBalances.push(cBalance);
      }
      consolidation.consolidation_key.split('-').forEach((w: string) => {
        usedOwnerBalances.add(w.toLowerCase());
      });
    }
  });

  const usedOwnerBalancesMemes = new Set<string>();
  ownersBalancesMemes.forEach((obm) => {
    const walletKey = obm.wallet.toLowerCase();
    if (usedOwnerBalancesMemes.has(walletKey)) {
      return;
    }

    const consolidation = walletConsolidations.find((wc) =>
      wc.consolidation_key.includes(walletKey)
    );

    if (!consolidation) {
      const consolidatedOwnerBalanceMemes: ConsolidatedOwnerBalancesMemes = {
        ...obm,
        consolidation_key: walletKey
      };
      consolidatedOwnersBalancesMemes.push(consolidatedOwnerBalanceMemes);
      usedOwnerBalances.add(walletKey);
    } else {
      const consolidationBalances = ownersBalancesMemes.filter(
        (oobm) =>
          consolidation.consolidation_key.includes(oobm.wallet.toLowerCase()) &&
          obm.season === oobm.season
      );
      if (consolidationBalances.length > 0) {
        const totals = consolidationBalances.reduce(
          (acc, cp) => {
            acc.balance += cp.balance;
            acc.unique += cp.unique;
            acc.sets += cp.sets;

            return acc;
          },
          {
            balance: 0,
            unique: 0,
            sets: 0
          }
        );
        const cBalance: ConsolidatedOwnerBalancesMemes = {
          consolidation_key: consolidation.consolidation_key,
          season: obm.season,
          ...totals
        };
        consolidatedOwnersBalancesMemes.push(cBalance);
      }
      consolidation.consolidation_key.split('-').forEach((w: string) => {
        usedOwnerBalances.add(w.toLowerCase());
      });
    }
  });

  startingConsolidatedOwnersBalances.forEach((sb) => {
    if (!usedOwnerBalances.has(sb.consolidation_key.toLowerCase())) {
      consolidatedOwnersBalances.push({
        ...sb,
        total_balance: 0
      });
    }
  });

  startingConsolidatedOwnersBalancesMemes.forEach((sbm) => {
    if (!usedOwnerBalances.has(sbm.consolidation_key.toLowerCase())) {
      consolidatedOwnersBalancesMemes.push({
        ...sbm,
        balance: 0
      });
    }
  });

  await persistConsolidatedOwnerBalances(
    consolidatedOwnersBalances,
    consolidatedOwnersBalancesMemes
  );
}
