import {
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEME_8_BURN_TRANSACTION,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_DEPLOYER,
  NULL_ADDRESS,
  PUNK_6529
} from '@/constants';
import { Transaction } from '../entities/ITransaction';
import {
  fetchAllSeasons,
  fetchMaxTransactionsBlockNumber,
  fetchTransactionsAfterBlock,
  fetchWalletConsolidationKeysViewForWallet,
  fetchWalletTransactions
} from '../db';
import { Logger } from '../logging';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { MemesSeason } from '../entities/ISeason';
import {
  fetchAllActivity,
  fetchAllActivityWallets,
  fetchAllMemesActivity,
  getMaxAggregatedActivityBlockReference,
  persistActivity,
  persistConsolidatedActivity
} from './db.aggregated_activity';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../nextgen/nextgen_constants';
import { equalIgnoreCase } from '../strings';
import { ethTools } from '../eth-tools';

const logger = Logger.get('AGGREGATED_ACTIVITY');
interface ActivityBreakdown {
  airdrops: Transaction[];
  primary_purchases: Transaction[];
  secondary_purchases: Transaction[];
  sales: Transaction[];
  burns: Transaction[];
  transfersIn: Transaction[];
  transfersOut: Transaction[];
}

async function getConsolidatedActivity(
  consolidationKey: string,
  addresses: string[]
): Promise<ConsolidatedAggregatedActivity> {
  const consolidationActivity = await fetchAllActivity(addresses);
  const consolidatedTotals = consolidationActivity.reduce(
    (acc, cp) => {
      // TOTAL
      acc.primary_purchases_value += cp.primary_purchases_value;
      acc.primary_purchases_count += cp.primary_purchases_count;
      acc.secondary_purchases_value += cp.secondary_purchases_value;
      acc.secondary_purchases_count += cp.secondary_purchases_count;
      acc.burns += cp.burns;
      acc.sales_value += cp.sales_value;
      acc.sales_count += cp.sales_count;
      acc.airdrops += cp.airdrops;
      acc.transfers_in += cp.transfers_in;
      acc.transfers_out += cp.transfers_out;
      // MEMES
      acc.primary_purchases_value_memes += cp.primary_purchases_value_memes;
      acc.primary_purchases_count_memes += cp.primary_purchases_count_memes;
      acc.secondary_purchases_value_memes += cp.secondary_purchases_value_memes;
      acc.secondary_purchases_count_memes += cp.secondary_purchases_count_memes;
      acc.burns_memes += cp.burns_memes;
      acc.sales_value_memes += cp.sales_value_memes;
      acc.sales_count_memes += cp.sales_count_memes;
      acc.airdrops_memes += cp.airdrops_memes;
      acc.transfers_in_memes += cp.transfers_in_memes;
      acc.transfers_out_memes += cp.transfers_out_memes;
      // MEMELAB
      acc.primary_purchases_value_memelab += cp.primary_purchases_value_memelab;
      acc.primary_purchases_count_memelab += cp.primary_purchases_count_memelab;
      acc.secondary_purchases_value_memelab +=
        cp.secondary_purchases_value_memelab;
      acc.secondary_purchases_count_memelab +=
        cp.secondary_purchases_count_memelab;
      acc.burns_memelab += cp.burns_memelab;
      acc.sales_value_memelab += cp.sales_value_memelab;
      acc.sales_count_memelab += cp.sales_count_memelab;
      acc.airdrops_memelab += cp.airdrops_memelab;
      acc.transfers_in_memelab += cp.transfers_in_memelab;
      acc.transfers_out_memelab += cp.transfers_out_memelab;
      // GRADIENTS
      acc.primary_purchases_value_gradients +=
        cp.primary_purchases_value_gradients;
      acc.primary_purchases_count_gradients +=
        cp.primary_purchases_count_gradients;
      acc.secondary_purchases_value_gradients +=
        cp.secondary_purchases_value_gradients;
      acc.secondary_purchases_count_gradients +=
        cp.secondary_purchases_count_gradients;
      acc.burns_gradients += cp.burns_gradients;
      acc.sales_value_gradients += cp.sales_value_gradients;
      acc.sales_count_gradients += cp.sales_count_gradients;
      acc.airdrops_gradients += cp.airdrops_gradients;
      acc.transfers_in_gradients += cp.transfers_in_gradients;
      acc.transfers_out_gradients += cp.transfers_out_gradients;
      // NEXTGEN
      acc.primary_purchases_value_nextgen += cp.primary_purchases_value_nextgen;
      acc.primary_purchases_count_nextgen += cp.primary_purchases_count_nextgen;
      acc.secondary_purchases_value_nextgen +=
        cp.secondary_purchases_value_nextgen;
      acc.secondary_purchases_count_nextgen +=
        cp.secondary_purchases_count_nextgen;
      acc.burns_nextgen += cp.burns_nextgen;
      acc.sales_value_nextgen += cp.sales_value_nextgen;
      acc.sales_count_nextgen += cp.sales_count_nextgen;
      acc.airdrops_nextgen += cp.airdrops_nextgen;
      acc.transfers_in_nextgen += cp.transfers_in_nextgen;
      acc.transfers_out_nextgen += cp.transfers_out_nextgen;

      return acc;
    },
    {
      // TOTAL
      primary_purchases_value: 0,
      primary_purchases_count: 0,
      secondary_purchases_value: 0,
      secondary_purchases_count: 0,
      burns: 0,
      sales_value: 0,
      sales_count: 0,
      airdrops: 0,
      transfers_in: 0,
      transfers_out: 0,
      // MEMES
      primary_purchases_value_memes: 0,
      primary_purchases_count_memes: 0,
      secondary_purchases_value_memes: 0,
      secondary_purchases_count_memes: 0,
      burns_memes: 0,
      sales_value_memes: 0,
      sales_count_memes: 0,
      airdrops_memes: 0,
      transfers_in_memes: 0,
      transfers_out_memes: 0,
      // MEMELAB
      primary_purchases_value_memelab: 0,
      primary_purchases_count_memelab: 0,
      secondary_purchases_value_memelab: 0,
      secondary_purchases_count_memelab: 0,
      burns_memelab: 0,
      sales_value_memelab: 0,
      sales_count_memelab: 0,
      airdrops_memelab: 0,
      transfers_in_memelab: 0,
      transfers_out_memelab: 0,
      // GRADIENTS
      primary_purchases_value_gradients: 0,
      primary_purchases_count_gradients: 0,
      secondary_purchases_value_gradients: 0,
      secondary_purchases_count_gradients: 0,
      burns_gradients: 0,
      sales_value_gradients: 0,
      sales_count_gradients: 0,
      airdrops_gradients: 0,
      transfers_in_gradients: 0,
      transfers_out_gradients: 0,
      // NEXTGEN
      primary_purchases_value_nextgen: 0,
      primary_purchases_count_nextgen: 0,
      secondary_purchases_value_nextgen: 0,
      secondary_purchases_count_nextgen: 0,
      burns_nextgen: 0,
      sales_value_nextgen: 0,
      sales_count_nextgen: 0,
      airdrops_nextgen: 0,
      transfers_in_nextgen: 0,
      transfers_out_nextgen: 0
    }
  );

  const cActivity: ConsolidatedAggregatedActivity = {
    consolidation_key: consolidationKey,
    ...consolidatedTotals
  };

  return cActivity;
}

async function getConsolidatedMemesActivity(
  seasons: MemesSeason[],
  consolidationKey: string,
  addresses: string[]
): Promise<ConsolidatedAggregatedActivityMemes[]> {
  const consolidationActivity = await fetchAllMemesActivity(addresses);
  if (consolidationActivity.length === 0) {
    return [];
  }
  const consolidatedMemesActivity: ConsolidatedAggregatedActivityMemes[] = [];
  seasons.forEach((season) => {
    const seasonActivity = consolidationActivity.filter(
      (ca) => ca.season === season.id
    );

    const consolidatedTotals = seasonActivity.reduce(
      (acc, cp) => {
        acc.primary_purchases_value += cp.primary_purchases_value;
        acc.primary_purchases_count += cp.primary_purchases_count;
        acc.secondary_purchases_value += cp.secondary_purchases_value;
        acc.secondary_purchases_count += cp.secondary_purchases_count;
        acc.airdrops += cp.airdrops;
        acc.burns += cp.burns;
        acc.sales_value += cp.sales_value;
        acc.sales_count += cp.sales_count;
        acc.transfers_in += cp.transfers_in;
        acc.transfers_out += cp.transfers_out;

        return acc;
      },
      {
        primary_purchases_value: 0,
        primary_purchases_count: 0,
        secondary_purchases_value: 0,
        secondary_purchases_count: 0,
        airdrops: 0,
        burns: 0,
        sales_value: 0,
        sales_count: 0,
        transfers_in: 0,
        transfers_out: 0
      }
    );

    if (
      consolidatedTotals.primary_purchases_count === 0 &&
      consolidatedTotals.secondary_purchases_count === 0 &&
      consolidatedTotals.airdrops === 0 &&
      consolidatedTotals.burns === 0 &&
      consolidatedTotals.sales_count === 0 &&
      consolidatedTotals.transfers_in === 0 &&
      consolidatedTotals.transfers_out === 0
    ) {
      return;
    }

    const cActivity: ConsolidatedAggregatedActivityMemes = {
      consolidation_key: consolidationKey,
      season: season.id,
      ...consolidatedTotals
    };
    consolidatedMemesActivity.push(cActivity);
  });

  return consolidatedMemesActivity;
}

export async function consolidateActivity(
  addresses: Set<string>,
  reset?: boolean
) {
  if (reset) {
    const allWallets = await fetchAllActivityWallets();
    addresses.clear();
    allWallets.forEach((wallet) => {
      addresses.add(wallet);
    });
  }

  logger.info(
    `[CONSOLIDATING OWNER ACTIVITY] [RESET ${reset}] [ADDRESSES ${addresses.size.toLocaleString()}]`
  );

  const seasons = await fetchAllSeasons();

  const consolidatedActivityMap = new Map<
    string,
    ConsolidatedAggregatedActivity
  >();
  const consolidatedMemesActivityMap = new Map<
    string,
    ConsolidatedAggregatedActivityMemes[]
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

      const cActivity = await getConsolidatedActivity(
        consolidationKey,
        consolidationAddresses
      );
      consolidatedActivityMap.set(consolidationKey, cActivity);

      const cMemesActivity = await getConsolidatedMemesActivity(
        seasons,
        consolidationKey,
        consolidationAddresses
      );
      consolidatedMemesActivityMap.set(consolidationKey, cMemesActivity);

      consolidationAddresses.forEach((address) => {
        deleteDelta.add(address);
      });
    })
  );

  const consolidatedActivity = Array.from(consolidatedActivityMap.values());
  const consolidatedMemesActivity = Array.from(
    consolidatedMemesActivityMap.values()
  ).flat();

  await persistConsolidatedActivity(
    consolidatedActivity,
    consolidatedMemesActivity,
    deleteDelta,
    reset
  );

  return {
    consolidatedActivity,
    consolidatedMemesActivity
  };
}

export const updateAggregatedActivity = async (reset?: boolean) => {
  const lastActivityBlock = reset
    ? 0
    : await getMaxAggregatedActivityBlockReference();
  reset = reset || lastActivityBlock === 0;
  let blockReference = await fetchMaxTransactionsBlockNumber();
  const seasons = await fetchAllSeasons();

  const nextgenNetwork = getNextgenNetwork();
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];

  logger.info(
    `[NEXTGEN_NETWORK ${nextgenNetwork}] : [NEXTGEN_CONTRACT ${NEXTGEN_CONTRACT}]`
  );

  const addresses = new Set<string>();
  const transactions: Transaction[] = await fetchTransactionsAfterBlock(
    [MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT, NEXTGEN_CONTRACT],
    lastActivityBlock,
    blockReference
  );

  transactions.forEach((wallet) => {
    addresses.add(wallet.from_address.toLowerCase());
    addresses.add(wallet.to_address.toLowerCase());
  });

  if (!addresses.size) {
    logger.info(`[NO WALLETS TO PROCESS]`);
    return;
  }

  const isValidTransactions = validateTransactions(transactions, seasons);
  if (!isValidTransactions) {
    logger.error(
      `[INVALID TRANSACTIONS DETECTED] : [BLOCK REFERENCE KEPT TO ${lastActivityBlock}]`
    );
    blockReference = lastActivityBlock;
  } else {
    logger.info(
      `[TRANSACTIONS VALIDATED ${transactions.length.toLocaleString()}]`
    );
  }

  logger.info(
    `[ADDRESSES ${addresses.size.toLocaleString()}] [lastActivityBlock ${lastActivityBlock}] [blockReference ${blockReference}] [RESET ${reset}]`
  );

  const walletsActivity = await retrieveActivityDelta(
    blockReference,
    seasons,
    Array.from(addresses),
    NEXTGEN_CONTRACT
  );

  await persistActivity(
    walletsActivity.aggregatedActivity,
    walletsActivity.memesAggregatedActivity,
    reset
  );

  const consolidatedWalletsActivity = await consolidateActivity(
    addresses,
    reset
  );

  return {
    walletsActivity,
    consolidatedWalletsActivity
  };
};

function getCount(arr: any[]): number {
  return [...arr].reduce(
    (sum, transaction) => sum + transaction.token_count,
    0
  );
}

function getValue(arr: any[]): number {
  return [...arr].reduce((sum, transaction) => sum + transaction.value, 0);
}

function isPunkGradient(t: Transaction) {
  return (
    equalIgnoreCase(t.from_address, PUNK_6529) &&
    equalIgnoreCase(t.contract, GRADIENT_CONTRACT)
  );
}

function getActivityBreakdown(
  transactionsIn: Transaction[],
  transactionsOut: Transaction[],
  contract: string
): ActivityBreakdown {
  let mintAddresses = [MANIFOLD, NULL_ADDRESS];
  if (equalIgnoreCase(contract, GRADIENT_CONTRACT)) {
    mintAddresses = [PUNK_6529];
  }

  return {
    airdrops: transactionsIn.filter(
      (t) => equalIgnoreCase(t.from_address, NULL_ADDRESS) && t.value === 0
    ),
    primary_purchases: transactionsIn.filter(
      (t) =>
        mintAddresses.some((ma) => equalIgnoreCase(ma, t.from_address)) &&
        t.value > 0
    ),
    secondary_purchases: transactionsIn.filter(
      (t) =>
        !mintAddresses.some((ma) => equalIgnoreCase(ma, t.from_address)) &&
        t.value > 0
    ),
    sales: transactionsOut.filter(
      (t) =>
        t.value > 0 &&
        !isPunkGradient(t) &&
        !equalIgnoreCase(t.to_address, NULL_ADDRESS)
    ),
    burns: transactionsOut.filter((t) =>
      equalIgnoreCase(t.to_address, NULL_ADDRESS)
    ),
    transfersIn: transactionsIn.filter(
      (t) => t.value == 0 && !equalIgnoreCase(t.from_address, NULL_ADDRESS)
    ),
    transfersOut: transactionsOut.filter(
      (t) =>
        (t.value == 0 || isPunkGradient(t)) &&
        !equalIgnoreCase(t.to_address, NULL_ADDRESS)
    )
  };
}

async function retrieveActivityDelta(
  targetActivityBlock: number,
  seasons: MemesSeason[],
  addresses: string[],
  nextgenContract: string
) {
  const aggregatedActivityMap = new Map<string, AggregatedActivity>();
  const memesAggregatedActivityMap = new Map<
    string,
    AggregatedActivityMemes[]
  >();

  await Promise.all(
    addresses.map(async (address) => {
      let addressTransactions: Transaction[] = await fetchWalletTransactions(
        [MEMES_CONTRACT, GRADIENT_CONTRACT, MEMELAB_CONTRACT, nextgenContract],
        address
      );

      if (ethTools.isNullOrDeadAddress(address)) {
        addressTransactions.forEach((at) => {
          at.value = 0;
        });
      }

      if (
        equalIgnoreCase(address, NULL_ADDRESS) ||
        equalIgnoreCase(address, MEMES_DEPLOYER)
      ) {
        logger.info(
          `[WALLET ${address}] [SKIPPING MEME CARD 8 BURN TRANSACTION ${MEME_8_BURN_TRANSACTION}]`
        );
        addressTransactions = addressTransactions.filter(
          (t) => !equalIgnoreCase(t.transaction, MEME_8_BURN_TRANSACTION)
        );
      }

      const transactionsIn = [...addressTransactions].filter((wt) =>
        equalIgnoreCase(wt.to_address, address)
      );
      const transactionsOut = [...addressTransactions].filter((wt) =>
        equalIgnoreCase(wt.from_address, address)
      );

      const memesTransactionsIn = filterContract(
        transactionsIn,
        MEMES_CONTRACT
      );
      const memesTransactionsOut = filterContract(
        transactionsOut,
        MEMES_CONTRACT
      );
      const memesLabTransactionsIn = filterContract(
        transactionsIn,
        MEMELAB_CONTRACT
      );
      const memesLabTransactionsOut = filterContract(
        transactionsOut,
        MEMELAB_CONTRACT
      );
      const gradientsTransactionsIn = filterContract(
        transactionsIn,
        GRADIENT_CONTRACT
      );
      const gradientsTransactionsOut = filterContract(
        transactionsOut,
        GRADIENT_CONTRACT
      );
      const nextgenTransactionsIn = filterContract(
        transactionsIn,
        nextgenContract
      );
      const nextgenTransactionsOut = filterContract(
        transactionsOut,
        nextgenContract
      );

      const memesActivity = getActivityBreakdown(
        memesTransactionsIn,
        memesTransactionsOut,
        MEMES_CONTRACT
      );
      const memelabActivity = getActivityBreakdown(
        memesLabTransactionsIn,
        memesLabTransactionsOut,
        MEMELAB_CONTRACT
      );
      const gradientsActivity = getActivityBreakdown(
        gradientsTransactionsIn,
        gradientsTransactionsOut,
        GRADIENT_CONTRACT
      );
      const nextgenActivity = getActivityBreakdown(
        nextgenTransactionsIn,
        nextgenTransactionsOut,
        nextgenContract
      );

      const aActivity = retrieveAggregatedActivityForWallet(
        address,
        targetActivityBlock,
        memesActivity,
        memelabActivity,
        gradientsActivity,
        nextgenActivity
      );
      aggregatedActivityMap.set(address, aActivity);

      const memesSeasonActivity = retrieveMemesSeasonActivityForWallet(
        address,
        seasons,
        memesActivity
      );
      memesAggregatedActivityMap.set(address, memesSeasonActivity);
    })
  );

  const aggregatedActivity = Array.from(aggregatedActivityMap.values());
  const memesAggregatedActivity = Array.from(
    memesAggregatedActivityMap.values()
  ).flat();

  return {
    aggregatedActivity,
    memesAggregatedActivity
  };
}

function retrieveAggregatedActivityForWallet(
  address: string,
  blockReference: number,
  memes: ActivityBreakdown,
  memeLab: ActivityBreakdown,
  gradients: ActivityBreakdown,
  nextgen: ActivityBreakdown
) {
  const aActivity: AggregatedActivity = {
    wallet: address,
    block_reference: blockReference,
    // TOTAL
    primary_purchases_value:
      getValue(memes.primary_purchases) +
      getValue(gradients.primary_purchases) +
      getValue(nextgen.primary_purchases) +
      getValue(memeLab.primary_purchases),
    primary_purchases_count:
      getCount(memes.primary_purchases) +
      getCount(gradients.primary_purchases) +
      getCount(nextgen.primary_purchases) +
      getCount(memeLab.primary_purchases),
    secondary_purchases_value:
      getValue(memes.secondary_purchases) +
      getValue(gradients.secondary_purchases) +
      getValue(nextgen.secondary_purchases) +
      getValue(memeLab.secondary_purchases),
    secondary_purchases_count:
      getCount(memes.secondary_purchases) +
      getCount(gradients.secondary_purchases) +
      getCount(nextgen.secondary_purchases) +
      getCount(memeLab.secondary_purchases),
    burns:
      getCount(memes.burns) +
      getCount(gradients.burns) +
      getCount(nextgen.burns) +
      getCount(memeLab.burns),
    sales_value:
      getValue(memes.sales) +
      getValue(gradients.sales) +
      getValue(nextgen.sales) +
      getValue(memeLab.sales),
    sales_count:
      getCount(memes.sales) +
      getCount(gradients.sales) +
      getCount(nextgen.sales) +
      getCount(memeLab.sales),
    airdrops:
      getCount(memes.airdrops) +
      getCount(gradients.airdrops) +
      getCount(nextgen.airdrops) +
      getCount(memeLab.airdrops),
    transfers_in:
      getCount(memes.transfersIn) +
      getCount(gradients.transfersIn) +
      getCount(nextgen.transfersIn) +
      getCount(memeLab.transfersIn),
    transfers_out:
      getCount(memes.transfersOut) +
      getCount(gradients.transfersOut) +
      getCount(nextgen.transfersOut) +
      getCount(memeLab.transfersOut),
    // MEMES
    primary_purchases_value_memes: getValue(memes.primary_purchases),
    primary_purchases_count_memes: getCount(memes.primary_purchases),
    secondary_purchases_value_memes: getValue(memes.secondary_purchases),
    secondary_purchases_count_memes: getCount(memes.secondary_purchases),
    burns_memes: getCount(memes.burns),
    sales_value_memes: getValue(memes.sales),
    sales_count_memes: getCount(memes.sales),
    airdrops_memes: getCount(memes.airdrops),
    transfers_in_memes: getCount(memes.transfersIn),
    transfers_out_memes: getCount(memes.transfersOut),
    // MEMELAB
    primary_purchases_value_memelab: getValue(memeLab.primary_purchases),
    primary_purchases_count_memelab: getCount(memeLab.primary_purchases),
    secondary_purchases_value_memelab: getValue(memeLab.secondary_purchases),
    secondary_purchases_count_memelab: getCount(memeLab.secondary_purchases),
    burns_memelab: getCount(memeLab.burns),
    sales_value_memelab: getValue(memeLab.sales),
    sales_count_memelab: getCount(memeLab.sales),
    airdrops_memelab: getCount(memeLab.airdrops),
    transfers_in_memelab: getCount(memeLab.transfersIn),
    transfers_out_memelab: getCount(memeLab.transfersOut),
    // GRADIENTS
    primary_purchases_value_gradients: getValue(gradients.primary_purchases),
    primary_purchases_count_gradients: getCount(gradients.primary_purchases),
    secondary_purchases_value_gradients: getValue(
      gradients.secondary_purchases
    ),
    secondary_purchases_count_gradients: getCount(
      gradients.secondary_purchases
    ),
    burns_gradients: getCount(gradients.burns),
    sales_value_gradients: getValue(gradients.sales),
    sales_count_gradients: getCount(gradients.sales),
    airdrops_gradients: getCount(gradients.airdrops),
    transfers_in_gradients: getCount(gradients.transfersIn),
    transfers_out_gradients: getCount(gradients.transfersOut),
    // NEXTGEN
    primary_purchases_value_nextgen: getValue(nextgen.primary_purchases),
    primary_purchases_count_nextgen: getCount(nextgen.primary_purchases),
    secondary_purchases_value_nextgen: getValue(nextgen.secondary_purchases),
    secondary_purchases_count_nextgen: getCount(nextgen.secondary_purchases),
    burns_nextgen: getCount(nextgen.burns),
    sales_value_nextgen: getValue(nextgen.sales),
    sales_count_nextgen: getCount(nextgen.sales),
    airdrops_nextgen: getCount(nextgen.airdrops),
    transfers_in_nextgen: getCount(nextgen.transfersIn),
    transfers_out_nextgen: getCount(nextgen.transfersOut)
  };
  return aActivity;
}

function retrieveMemesSeasonActivityForWallet(
  wallet: string,
  seasons: MemesSeason[],
  activity: ActivityBreakdown
) {
  const memesAggregatedActivity: AggregatedActivityMemes[] = [];
  seasons.forEach((season) => {
    const airdrops = [...activity.airdrops].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const primaryPurchases = [...activity.primary_purchases].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const secondaryPurchases = [...activity.secondary_purchases].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const burns = [...activity.burns].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const sales = [...activity.sales].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const transfersIn = [...activity.transfersIn].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const transfersOut = [...activity.transfersOut].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );

    if (
      primaryPurchases.length === 0 &&
      secondaryPurchases.length === 0 &&
      burns.length === 0 &&
      sales.length === 0 &&
      transfersIn.length === 0 &&
      transfersOut.length === 0 &&
      airdrops.length === 0
    ) {
      return;
    }
    const seasonMemeActivity: AggregatedActivityMemes = {
      wallet: wallet,
      season: season.id,
      primary_purchases_value: getValue(primaryPurchases),
      primary_purchases_count: getCount(primaryPurchases),
      secondary_purchases_value: getValue(secondaryPurchases),
      secondary_purchases_count: getCount(secondaryPurchases),
      burns: getCount(burns),
      sales_value: getValue(sales),
      sales_count: getCount(sales),
      airdrops: getCount(airdrops),
      transfers_in: getCount(transfersIn),
      transfers_out: getCount(transfersOut)
    };
    memesAggregatedActivity.push(seasonMemeActivity);
  });

  return memesAggregatedActivity;
}

function filterContract(transactions: Transaction[], contract: string) {
  return [...transactions].filter((a) => equalIgnoreCase(a.contract, contract));
}

function validateTransactions(
  transactions: Transaction[],
  seasons: MemesSeason[]
) {
  const isValidMemesSeasons = validateMemesSeasonsTransactions(
    transactions,
    seasons
  );
  return isValidMemesSeasons;
}

function validateMemesSeasonsTransactions(
  transactions: Transaction[],
  seasons: MemesSeason[]
) {
  const memesTx = filterContract(transactions, MEMES_CONTRACT);
  const maxSeasonIndex = Math.max(...[...seasons].map((s) => s.end_index));
  return !memesTx.some((tx) => tx.token_id > maxSeasonIndex);
}
