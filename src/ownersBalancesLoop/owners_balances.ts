import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { areEqualAddresses } from '../helpers';
import {
  fetchAllOwnerBalances,
  fetchAllOwnerBalancesMemes,
  persistOwnerBalances,
  persistConsolidatedOwnerBalances,
  getMaxOwnerBalancesBlockReference
} from './db.owners_balances';
import {
  fetchAllSeasons,
  fetchTransactionAddressesFromBlock,
  fetchWalletConsolidationKeysViewForWallet
} from '../db';
import { Logger } from '../logging';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { MemesSeason } from '../entities/ISeason';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../nextgen/nextgen_constants';
import { NFTOwner } from '../entities/INFTOwner';
import {
  fetchAllNftOwners,
  getMaxNftOwnersBlockReference
} from '../nftOwnersLoop/db.nft_owners';

const logger = Logger.get('OWNER_BALANCES');

export const findOwnerBalances = async (reset?: boolean) => {
  const lastBalancesBlock = await getMaxOwnerBalancesBlockReference();

  reset = lastBalancesBlock === 0;

  const blockReference = await getMaxNftOwnersBlockReference();
  const seasons = await fetchAllSeasons();

  const nextgenNetwork = getNextgenNetwork();
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[nextgenNetwork];

  const allContracts = [
    MEMES_CONTRACT,
    MEMELAB_CONTRACT,
    GRADIENT_CONTRACT,
    NEXTGEN_CONTRACT
  ];

  let addresses = new Set<string>();
  let owners: NFTOwner[] = [];

  if (reset) {
    owners = await fetchAllNftOwners(allContracts);
    addresses.clear();
    owners.forEach((o) => addresses.add(o.wallet.toLowerCase()));
  } else {
    const allTransactionAddresses: {
      from_address: string;
      to_address: string;
    }[] = await fetchTransactionAddressesFromBlock(
      allContracts,
      lastBalancesBlock
    );
    allTransactionAddresses.forEach((wallet) => {
      addresses.add(wallet.from_address.toLowerCase());
      addresses.add(wallet.to_address.toLowerCase());
    });
    if (!addresses.size) {
      logger.info(`[NO WALLETS TO PROCESS]`);
      return;
    }
    owners = await fetchAllNftOwners(allContracts, Array.from(addresses));
  }

  const ownersBalancesMap = new Map<string, OwnerBalances>();
  const ownersBalancesMemesMap = new Map<string, OwnerBalancesMemes[]>();

  logger.info(
    `[ADDRESSES ${addresses.size.toLocaleString()}] [lastBalancesBlock ${lastBalancesBlock}] [blockReference ${blockReference}] [RESET ${reset}]`
  );

  addresses.forEach((address) => {
    const ownedNfts = owners.filter((o) =>
      areEqualAddresses(o.wallet, address)
    );
    const ownerBalance = buildOwnerBalance(
      NEXTGEN_CONTRACT,
      seasons,
      blockReference,
      address,
      ownedNfts
    );

    const ownerBalanceMemes = buildSeasonBalances(seasons, address, ownedNfts);

    ownersBalancesMap.set(address, ownerBalance);
    ownersBalancesMemesMap.set(address, ownerBalanceMemes);
  });

  const ownersBalances = Array.from(ownersBalancesMap.values());
  const ownersBalancesMemes = Array.from(
    ownersBalancesMemesMap.values()
  ).flat();
  await persistOwnerBalances(ownersBalances, ownersBalancesMemes, reset);

  await consolidateOwnerBalances(addresses, reset);
};

function buildOwnerBalance(
  NEXTGEN_CONTRACT: string,
  seasons: MemesSeason[],
  blockReference: number,
  wallet: string,
  ownedNfts: NFTOwner[]
): OwnerBalances {
  const memes = filterContract(ownedNfts, MEMES_CONTRACT);
  const gradients = filterContract(ownedNfts, GRADIENT_CONTRACT);
  const nextgen = filterContract(ownedNfts, NEXTGEN_CONTRACT);
  const memelab = filterContract(ownedNfts, MEMELAB_CONTRACT);

  const memeCard1Balance = getTokenIdBalance(memes, 1);
  const memeCard2Balance = getTokenIdBalance(memes, 1);
  const memeCard3Balance = getTokenIdBalance(memes, 1);

  const genesis = Math.min(
    memeCard1Balance,
    memeCard2Balance,
    memeCard3Balance
  );

  const naka = getTokenIdBalance(memes, 4);

  const maxSeasonIndex = Math.max(...[...seasons].map((s) => s.end_index));

  let memesCardSets = 0;
  let memesCardSetsMinus1 = 0;
  let memesCardSetsMinus2 = 0;
  let walletMemesSet1: any[] = [];
  let walletMemesSet2: any[] = [];
  if (memes.length >= maxSeasonIndex) {
    memesCardSets = Math.min(...[...memes].map((o) => o.balance));
    walletMemesSet1 = [...memes].filter((n) => n.balance > memesCardSets);
  } else {
    walletMemesSet1 = [...memes];
  }
  if (walletMemesSet1.length == maxSeasonIndex - 1) {
    memesCardSetsMinus1 =
      Math.min(...[...walletMemesSet1].map((o) => o.balance)) - memesCardSets;
    walletMemesSet2 = [...walletMemesSet1].filter(
      (n) => n.balance > memesCardSetsMinus1
    );
  } else {
    walletMemesSet2 = [...walletMemesSet1];
  }
  if (walletMemesSet2.length == maxSeasonIndex - 2) {
    memesCardSetsMinus2 =
      Math.min(...[...walletMemesSet2].map((o) => o.balance)) -
      memesCardSetsMinus1;
  }

  const memesBalance = memes.reduce((acc, n) => acc + n.balance, 0);
  const memelabBalance = memelab.reduce((acc, n) => acc + n.balance, 0);
  const totalBalance =
    memesBalance + gradients.length + nextgen.length + memelabBalance;

  const ownerBalance: OwnerBalances = {
    wallet: wallet,
    total_balance: totalBalance,
    gradients_balance: gradients.length,
    nextgen_balance: nextgen.length,
    memelab_balance: memelabBalance,
    unique_memelab: memelab.length,
    memes_balance: memesBalance,
    unique_memes: memes.length,
    genesis: genesis,
    nakamoto: naka,
    memes_cards_sets: memesCardSets,
    memes_cards_sets_minus1: memesCardSetsMinus1,
    memes_cards_sets_minus2: memesCardSetsMinus2,
    block_reference: blockReference
  };
  return ownerBalance;
}

function buildSeasonBalances(
  seasons: MemesSeason[],
  wallet: string,
  ownedNfts: NFTOwner[]
) {
  const memes = filterContract(ownedNfts, MEMES_CONTRACT);

  const seasonMemes = new Map<number, NFTOwner[]>();
  seasons.forEach((s) => {
    const seasonOwned = memes.filter(
      (n) => n.token_id >= s.start_index && n.token_id <= s.end_index
    );
    seasonMemes.set(s.id, seasonOwned);
  });

  const seasonBalances: OwnerBalancesMemes[] = [];
  seasonMemes.forEach((owners, seasonId) => {
    let seasonBalance = 0;
    owners.forEach((o) => (seasonBalance += o.balance));

    const seasonSets = Math.min(
      ...[...owners].map(function (o) {
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
    seasonBalances.push(oBalanceMemes);
  });
  return seasonBalances;
}

async function getConsolidatedBalances(
  consolidationKey: string,
  addresses: string[]
): Promise<ConsolidatedOwnerBalances> {
  const consolidationActivity = await fetchAllOwnerBalances(addresses);

  const consolidatedTotals = consolidationActivity.reduce(
    (acc, cp) => {
      acc.total_balance += cp.total_balance;
      acc.gradients_balance += cp.gradients_balance;
      acc.nextgen_balance += cp.nextgen_balance;
      acc.memelab_balance += cp.memelab_balance;
      acc.unique_memelab += cp.unique_memelab;
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
      nextgen_balance: 0,
      memelab_balance: 0,
      unique_memelab: 0,
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
    consolidation_key: consolidationKey,
    ...consolidatedTotals
  };

  return cBalance;
}

async function getConsolidatedMemesBalances(
  seasons: MemesSeason[],
  consolidationKey: string,
  addresses: string[]
): Promise<ConsolidatedOwnerBalancesMemes[]> {
  const consolidationActivity = await fetchAllOwnerBalancesMemes(addresses);
  if (consolidationActivity.length === 0) {
    return [];
  }

  const consolidatedMemesBalances: ConsolidatedOwnerBalancesMemes[] = [];
  seasons.forEach((season) => {
    const seasonBalances = consolidationActivity.filter(
      (ca) => ca.season === season.id
    );

    const consolidatedTotals = seasonBalances.reduce(
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

    if (consolidatedTotals.balance === 0) {
      return;
    }

    const cBalance: ConsolidatedOwnerBalancesMemes = {
      consolidation_key: consolidationKey,
      season: season.id,
      ...consolidatedTotals
    };
    consolidatedMemesBalances.push(cBalance);
  });

  return consolidatedMemesBalances;
}

export async function consolidateOwnerBalances(
  addresses: Set<string>,
  reset?: boolean
) {
  if (reset) {
    const ownerBalances = await fetchAllOwnerBalances();
    ownerBalances.forEach((o) => addresses.add(o.wallet));
  }

  logger.info(
    `[CONSOLIDATING ${addresses.size.toLocaleString()} ADDRESSES] [RESET ${reset}]`
  );

  const seasons = await fetchAllSeasons();

  const consolidatedOwnersBalancesMap = new Map<
    string,
    ConsolidatedOwnerBalances
  >();
  const consolidatedOwnersBalancesMemesMap = new Map<
    string,
    ConsolidatedOwnerBalancesMemes[]
  >();
  const deleteDelta = new Set<string>();

  await Promise.all(
    Array.from(addresses).map(async (address) => {
      const consolidation = (
        await fetchWalletConsolidationKeysViewForWallet([address])
      )?.[0];

      let consolidationKey: string;
      let consolidationAddresses: string[] = [];
      if (!consolidation) {
        consolidationKey = address.toLowerCase();
        consolidationAddresses.push(address.toLowerCase());
      } else {
        consolidationKey = consolidation.consolidation_key;
        consolidationAddresses = consolidation.consolidation_key.split('-');
      }

      const oBalance = await getConsolidatedBalances(
        consolidationKey,
        consolidationAddresses
      );
      consolidatedOwnersBalancesMap.set(consolidationKey, oBalance);

      const oMemesBalances = await getConsolidatedMemesBalances(
        seasons,
        consolidationKey,
        consolidationAddresses
      );
      consolidatedOwnersBalancesMemesMap.set(consolidationKey, oMemesBalances);
      consolidationAddresses.forEach((address) => {
        deleteDelta.add(address);
      });
    })
  );

  const consolidatedOwnersBalances = Array.from(
    consolidatedOwnersBalancesMap.values()
  );
  const consolidatedOwnersBalancesMemes = Array.from(
    consolidatedOwnersBalancesMemesMap.values()
  ).flat();

  await persistConsolidatedOwnerBalances(
    consolidatedOwnersBalances,
    consolidatedOwnersBalancesMemes,
    deleteDelta,
    reset ?? false
  );

  return {
    consolidatedOwnersBalances,
    consolidatedOwnersBalancesMemes
  };
}

function filterContract(nfts: NFTOwner[], contract: string) {
  return [...nfts].filter((a) => areEqualAddresses(a.contract, contract));
}

function getTokenIdBalance(nfts: NFTOwner[], tokenId: number) {
  const tokenNfts = filterTokenId(nfts, tokenId);
  return tokenNfts.reduce((acc, n) => acc + n.balance, 0);
}

function filterTokenId(nfts: NFTOwner[], tokenId: number) {
  return [...nfts].filter((a) => a.token_id == tokenId);
}
