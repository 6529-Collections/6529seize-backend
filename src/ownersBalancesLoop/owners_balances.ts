import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  NULL_ADDRESS
} from '../constants';
import { areEqualAddresses } from '../helpers';
import {
  fetchAllOwnerBalances,
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

const validateNftOwners = (
  owners: NFTOwner[],
  seasons: MemesSeason[]
): boolean => {
  const isValidMemesSeasons = validateMemesSeasonsOwners(owners, seasons);
  return isValidMemesSeasons;
};

const validateMemesSeasonsOwners = (
  owners: NFTOwner[],
  seasons: MemesSeason[]
): boolean => {
  const memes = filterContract(owners, MEMES_CONTRACT);
  const maxSeasonIndex = Math.max(...[...seasons].map((s) => s.end_index));
  return !memes.some((m) => m.token_id > maxSeasonIndex);
};

interface BalancesFields {
  total_balance: number;
  gradients_balance: number;
  nextgen_balance: number;
  memelab_balance: number;
  unique_memelab: number;
  memes_balance: number;
  unique_memes: number;
  genesis: number;
  nakamoto: number;
  memes_cards_sets: number;
  memes_cards_sets_minus1: number;
  memes_cards_sets_minus2: number;
}

interface MemesBalancesFields {
  season: number;
  balance: number;
  unique: number;
  sets: number;
}

export const updateOwnerBalances = async (reset?: boolean) => {
  const lastBalancesBlock = await getMaxOwnerBalancesBlockReference();

  reset = reset || lastBalancesBlock === 0;

  let blockReference = await getMaxNftOwnersBlockReference();
  const seasons = await fetchAllSeasons();

  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];
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
    const transactionAddresses: { from_address: string; to_address: string }[] =
      await fetchTransactionAddressesFromBlock(
        allContracts,
        lastBalancesBlock,
        blockReference
      );
    transactionAddresses.forEach((wallet) => {
      addresses.add(wallet.from_address.toLowerCase());
      addresses.add(wallet.to_address.toLowerCase());
    });
    if (!addresses.size) {
      logger.info(`[NO WALLETS TO PROCESS]`);
      return;
    }
    owners = await fetchAllNftOwners(allContracts, Array.from(addresses));
  }

  const isValidOwners = validateNftOwners(owners, seasons);
  if (!isValidOwners) {
    logger.error(
      `[INVALID OWNERS DETECTED] : [BLOCK REFERENCE KEPT TO ${lastBalancesBlock}]`
    );
    blockReference = lastBalancesBlock;
  } else {
    logger.info(`[OWNERS VALIDATED ${owners.length.toLocaleString()}]`);
  }

  logger.info(
    `[ADDRESSES ${addresses.size.toLocaleString()}] [lastBalancesBlock ${lastBalancesBlock}] [blockReference ${blockReference}] [RESET ${reset}]`
  );

  const ownersBalancesMap = new Map<string, OwnerBalances>();
  const ownersBalancesMemesMap = new Map<string, OwnerBalancesMemes[]>();
  const deleteDelta = new Set<string>();

  addresses.forEach((address) => {
    const ownedNfts = owners.filter((o) =>
      areEqualAddresses(o.wallet, address)
    );
    if (!ownedNfts.length) {
      deleteDelta.add(address);
      return;
    }
    const ownerBalanceFields = buildOwnerBalance(seasons, ownedNfts, address);
    const ownerBalance: OwnerBalances = {
      wallet: address,
      block_reference: blockReference,
      ...ownerBalanceFields
    };

    const ownerBalancesMemesFields = buildSeasonBalances(seasons, ownedNfts);
    const ownerBalanceMemes = ownerBalancesMemesFields.map((o) => ({
      ...o,
      wallet: address,
      block_reference: blockReference
    }));

    ownersBalancesMap.set(address, ownerBalance);
    ownersBalancesMemesMap.set(address, ownerBalanceMemes);
  });

  const ownersBalances = Array.from(ownersBalancesMap.values());
  const ownersBalancesMemes = Array.from(
    ownersBalancesMemesMap.values()
  ).flat();
  await persistOwnerBalances(
    ownersBalances,
    ownersBalancesMemes,
    deleteDelta,
    reset
  );

  await consolidateOwnerBalances(addresses, reset);
};

function buildOwnerBalance(
  seasons: MemesSeason[],
  ownedNfts: NFTOwner[],
  pk: string
): BalancesFields {
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];

  const memes = filterContract(ownedNfts, MEMES_CONTRACT);
  const gradients = filterContract(ownedNfts, GRADIENT_CONTRACT);
  const nextgen = filterContract(ownedNfts, NEXTGEN_CONTRACT);
  const memelab = filterContract(ownedNfts, MEMELAB_CONTRACT);

  const memeCard1Balance = getTokenIdBalance(memes, 1);
  const memeCard2Balance = getTokenIdBalance(memes, 2);
  const memeCard3Balance = getTokenIdBalance(memes, 3);

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

  let memesBalance = memes.reduce((acc, n) => acc + n.balance, 0);
  if (areEqualAddresses(pk, NULL_ADDRESS)) {
    memesBalance += MEME_8_EDITION_BURN_ADJUSTMENT;
  }
  const memelabBalance = memelab.reduce((acc, n) => acc + n.balance, 0);
  const totalBalance =
    memesBalance + gradients.length + nextgen.length + memelabBalance;

  const ownerBalance: BalancesFields = {
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
    memes_cards_sets_minus2: memesCardSetsMinus2
  };
  return ownerBalance;
}

function buildSeasonBalances(
  seasons: MemesSeason[],
  ownedNfts: NFTOwner[]
): MemesBalancesFields[] {
  const memes = filterContract(ownedNfts, MEMES_CONTRACT);

  const seasonMemes = new Map<number, NFTOwner[]>();
  seasons.forEach((s) => {
    const seasonOwned = memes.filter(
      (n) => n.token_id >= s.start_index && n.token_id <= s.end_index
    );
    seasonMemes.set(s.id, seasonOwned);
  });

  const seasonBalances: MemesBalancesFields[] = [];
  seasonMemes.forEach((owners, seasonId) => {
    let seasonBalance = 0;
    owners.forEach((o) => (seasonBalance += o.balance));

    const seasonCount = seasons.find((s) => s.id === seasonId)?.count ?? 0;
    const seasonSets =
      owners.length === seasonCount
        ? Math.min(...owners.map((o) => o.balance))
        : 0;

    const oBalanceMemes: MemesBalancesFields = {
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
  seasons: MemesSeason[],
  contracts: string[],
  consolidationKey: string,
  addresses: string[]
): Promise<{
  balance: ConsolidatedOwnerBalances;
  memes: ConsolidatedOwnerBalancesMemes[];
}> {
  const owners = await fetchAllNftOwners(contracts, Array.from(addresses));
  const consolidatedOwners = new Map<string, NFTOwner>();
  owners.forEach((o) => {
    const key = `${o.contract}_${o.token_id}`;
    const consolidated = consolidatedOwners.get(key);
    if (consolidated) {
      consolidated.balance += o.balance;
      consolidatedOwners.set(key, consolidated);
    } else {
      consolidatedOwners.set(key, o);
    }
  });

  const consolidatedFields = buildOwnerBalance(
    seasons,
    Array.from(consolidatedOwners.values()),
    consolidationKey
  );

  const cBalance: ConsolidatedOwnerBalances = {
    consolidation_key: consolidationKey,
    ...consolidatedFields
  };

  const consolidatedMemesFields = buildSeasonBalances(
    seasons,
    Array.from(consolidatedOwners.values())
  );

  const cMemesBalances = consolidatedMemesFields.map((o) => ({
    ...o,
    consolidation_key: consolidationKey
  }));

  return {
    balance: cBalance,
    memes: cMemesBalances
  };
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

  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];
  const allContracts = [
    MEMES_CONTRACT,
    MEMELAB_CONTRACT,
    GRADIENT_CONTRACT,
    NEXTGEN_CONTRACT
  ];

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
      )[0];

      let consolidationKey: string;
      let consolidationAddresses: string[] = [];
      if (!consolidation) {
        consolidationKey = address.toLowerCase();
        consolidationAddresses.push(address.toLowerCase());
      } else {
        consolidationKey = consolidation.consolidation_key;
        consolidationAddresses = consolidation.consolidation_key.split('-');
      }

      const consolidatedBalances = await getConsolidatedBalances(
        seasons,
        allContracts,
        consolidationKey,
        consolidationAddresses
      );
      consolidatedOwnersBalancesMap.set(
        consolidationKey,
        consolidatedBalances.balance
      );
      consolidatedOwnersBalancesMemesMap.set(
        consolidationKey,
        consolidatedBalances.memes
      );
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
