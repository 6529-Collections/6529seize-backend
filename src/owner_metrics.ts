import {
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  PUNK_6529
} from './constants';
import {
  OwnerTransactions,
  ConsolidatedOwnerTransactions
} from './entities/IOwner';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import {
  fetchWalletTransactions,
  fetchDistinctOwnerWallets,
  fetchLastOwnerMetrics,
  fetchTransactionsFromDate,
  retrieveWalletConsolidations,
  fetchAllSeasons,
  fetchAllOwnerTransactions,
  fetchAllWalletConsolidations,
  persistConsolidatedOwnerTransactions,
  persistOwnerTransactions
} from './db';
import { Logger } from './logging';
import { MemesSeason } from './entities/ISeason';
import { WalletConsolidation } from './entities/IWalletConsolidation';

const logger = Logger.get('OWNER_METRICS');

function getOwnerTransaction(
  wallet: string,
  contract: string,
  season: number,
  purchasesPrimary: Transaction[],
  purchasesSecondary: Transaction[],
  burns: Transaction[],
  sales: Transaction[],
  airdrops: Transaction[],
  transfersIn: Transaction[],
  transfersOut: Transaction[]
): OwnerTransactions {
  const tr: OwnerTransactions = {
    wallet: wallet.toLowerCase(),
    contract: contract,
    season: season,
    primary_purchases_count: getCount(purchasesPrimary),
    primary_purchases_value: getValue(purchasesPrimary),
    secondary_purchases_count: getCount(purchasesSecondary),
    secondary_purchases_value: getValue(purchasesSecondary),
    burns: getCount(burns),
    sales_count: getCount(sales),
    sales_value: getValue(sales),
    airdrops: getCount(airdrops),
    transfers_in: getCount(transfersIn),
    transfers_out: getCount(transfersOut)
  };
  return tr;
}

function getGradientsOwnerTransaction(
  wallet: string,
  purchases: Transaction[],
  burns: Transaction[],
  sales: Transaction[],
  transfersIn: Transaction[],
  transfersOut: Transaction[]
): OwnerTransactions {
  const purchasesPrimary = [...purchases].filter((t) =>
    areEqualAddresses(PUNK_6529, t.from_address)
  );
  const purchasesSecondary = [...purchases].filter(
    (t) => !areEqualAddresses(PUNK_6529, t.from_address)
  );

  return getOwnerTransaction(
    wallet,
    GRADIENT_CONTRACT,
    1,
    purchasesPrimary,
    purchasesSecondary,
    burns,
    sales,
    [],
    transfersIn,
    transfersOut
  );
}

function getMemesOwnerTransaction(
  wallet: string,
  season: MemesSeason,
  purchases: Transaction[],
  burns: Transaction[],
  sales: Transaction[],
  transfersIn: Transaction[],
  transfersOut: Transaction[]
) {
  const seasonPurchasesPrimary = [...purchases].filter(
    (t) =>
      areEqualAddresses(MANIFOLD, t.from_address) ||
      areEqualAddresses(NULL_ADDRESS, t.from_address)
  );
  const seasonPurchasesSecondary = [...purchases].filter(
    (t) =>
      !areEqualAddresses(MANIFOLD, t.from_address) &&
      !areEqualAddresses(NULL_ADDRESS, t.from_address)
  );
  const airdrops: Transaction[] = [];
  const transfersInFiltered: Transaction[] = [];
  transfersIn.forEach((t) => {
    if (areEqualAddresses(t.from_address, NULL_ADDRESS)) {
      airdrops.push(t);
    } else {
      transfersInFiltered.push(t);
    }
  });

  return getOwnerTransaction(
    wallet,
    MEMES_CONTRACT,
    season.id,
    seasonPurchasesPrimary,
    seasonPurchasesSecondary,
    burns,
    sales,
    airdrops,
    transfersInFiltered,
    transfersOut
  );
}

function getTransactions(
  wallet: string,
  purchases: Transaction[],
  burns: Transaction[],
  sales: Transaction[],
  transfersIn: Transaction[],
  transfersOut: Transaction[],
  seasons: MemesSeason[]
) {
  const purchasesGradients: Transaction[] = [];
  const purchasesMemes: Transaction[] = [];
  purchases.forEach((p) => {
    if (areEqualAddresses(p.contract, GRADIENT_CONTRACT)) {
      purchasesGradients.push(p);
    }
    if (areEqualAddresses(p.contract, MEMES_CONTRACT)) {
      purchasesMemes.push(p);
    }
  });

  const burnsGradients: Transaction[] = [];
  const burnsMemes: Transaction[] = [];
  burns.forEach((p) => {
    if (areEqualAddresses(p.contract, GRADIENT_CONTRACT)) {
      burnsGradients.push(p);
    }
    if (areEqualAddresses(p.contract, MEMES_CONTRACT)) {
      burnsMemes.push(p);
    }
  });
  const salesGradients: Transaction[] = [];
  const salesMemes: Transaction[] = [];
  sales.forEach((p) => {
    if (areEqualAddresses(p.contract, GRADIENT_CONTRACT)) {
      salesGradients.push(p);
    }
    if (areEqualAddresses(p.contract, MEMES_CONTRACT)) {
      salesMemes.push(p);
    }
  });
  const transfersInGradients: Transaction[] = [];
  const transfersInMemes: Transaction[] = [];
  transfersIn.forEach((p) => {
    if (areEqualAddresses(p.contract, GRADIENT_CONTRACT)) {
      transfersInGradients.push(p);
    }
    if (areEqualAddresses(p.contract, MEMES_CONTRACT)) {
      transfersInMemes.push(p);
    }
  });
  const transfersOutGradients: Transaction[] = [];
  const transfersOutMemes: Transaction[] = [];
  transfersOut.forEach((p) => {
    if (areEqualAddresses(p.contract, GRADIENT_CONTRACT)) {
      transfersOutGradients.push(p);
    }
    if (areEqualAddresses(p.contract, MEMES_CONTRACT)) {
      transfersOutMemes.push(p);
    }
  });

  const gradientsOwnerTransaction = getGradientsOwnerTransaction(
    wallet,
    purchasesGradients,
    burnsGradients,
    salesGradients,
    transfersInGradients,
    transfersOutGradients
  );

  const memesOwnerTransactions: OwnerTransactions[] = [];

  seasons.forEach((season) => {
    const seasonPurchasesMemes = [...purchasesMemes].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const seasonBurnsMemes = [...burnsMemes].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const seasonSalesMemes = [...salesMemes].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const seasonTransfersInMemes = [...transfersInMemes].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const seasonTransfersOutMemes = [...transfersOutMemes].filter(
      (t) => season.end_index >= t.token_id && t.token_id >= season.start_index
    );
    const seasonMemeTransaction = getMemesOwnerTransaction(
      wallet,
      season,
      seasonPurchasesMemes,
      seasonBurnsMemes,
      seasonSalesMemes,
      seasonTransfersInMemes,
      seasonTransfersOutMemes
    );
    memesOwnerTransactions.push(seasonMemeTransaction);
  });

  return [gradientsOwnerTransaction, ...memesOwnerTransactions];
}

export const findOwnerMetrics = async (reset?: boolean) => {
  const lastMetricsDate = await fetchLastOwnerMetrics();
  const seasons = await fetchAllSeasons();

  let owners: { wallet: string }[];

  const transactionReference = new Date();

  if (!lastMetricsDate || reset) {
    owners = await fetchDistinctOwnerWallets();
  } else {
    const allWallets: { from_address: string; to_address: string }[] =
      await fetchTransactionsFromDate(new Date(lastMetricsDate));
    const addresses = new Set<string>();
    allWallets.forEach((wallet) => {
      addresses.add(wallet.from_address);
      addresses.add(wallet.to_address);
    });

    owners = Array.from(addresses).map((address) => {
      return { wallet: address };
    });
  }

  logger.info(
    `[OWNERS ${owners.length}] [lastMetricsDate ${lastMetricsDate}] [transactionReference ${transactionReference}] [RESET ${reset}]`
  );

  const ownerTransactions: OwnerTransactions[] = [];

  const ownerWallets: string[] = [];
  await Promise.all(
    owners.map(async (owner) => {
      const consolidations = await retrieveWalletConsolidations(owner.wallet);
      consolidations.forEach((c) => {
        ownerWallets.push(c.toLowerCase());
      });
    })
  );

  await Promise.all(
    ownerWallets.map(async (wallet) => {
      const consolidations = await retrieveWalletConsolidations(wallet);

      const consolidationTransactions: Transaction[] = [];
      await Promise.all(
        consolidations.map(async (c) => {
          const walletTransactions: Transaction[] =
            await fetchWalletTransactions(c);
          consolidationTransactions.push(...walletTransactions);
        })
      );

      if (consolidationTransactions.length > 0) {
        const transactionsIn = [...consolidationTransactions].filter((wt) =>
          areEqualAddresses(wt.to_address, wallet)
        );
        const transactionsOut = [...consolidationTransactions].filter((wt) =>
          areEqualAddresses(wt.from_address, wallet)
        );

        const purchases = [...transactionsIn].filter((t) => t.value > 0);
        const sales = [...transactionsOut].filter(
          (t) => t.value > 0 && !areEqualAddresses(t.to_address, NULL_ADDRESS)
        );
        const burns = [...transactionsOut].filter((t) =>
          areEqualAddresses(t.to_address, NULL_ADDRESS)
        );
        const transfersIn = [...transactionsIn].filter(
          (t) =>
            t.value == 0 && !areEqualAddresses(t.from_address, NULL_ADDRESS)
        );
        const transfersOut = [...transactionsOut].filter(
          (t) =>
            (t.value == 0 || isPunkGradient(t)) &&
            !areEqualAddresses(t.to_address, NULL_ADDRESS)
        );

        const oTransactions: OwnerTransactions[] = getTransactions(
          wallet,
          purchases,
          burns,
          sales,
          transfersIn,
          transfersOut,
          seasons
        );

        ownerTransactions.push(...oTransactions);
      }
    })
  );

  logger.info(`[OWNERS METRICS] [DELTA ${ownerTransactions.length}]`);

  const copyOfOwnerTransactions = JSON.parse(JSON.stringify(ownerTransactions));
  await persistOwnerTransactions(copyOfOwnerTransactions, reset);

  const walletConsolidations = await fetchAllWalletConsolidations();
  const consolidatedOwnerTransactions = await consolidateTransactions(
    walletConsolidations,
    ownerTransactions,
    reset
  );
  await persistConsolidatedOwnerTransactions(
    consolidatedOwnerTransactions,
    reset
  );

  return {
    ownerTransactions,
    consolidatedOwnerTransactions
  };
};

function getCount(arr: any[]) {
  return [...arr].reduce(
    (sum, transaction) => sum + transaction.token_count,
    0
  );
}

function getValue(arr: any[]) {
  return [...arr].reduce((sum, transaction) => sum + transaction.value, 0);
}

function isPunkGradient(t: Transaction) {
  return (
    areEqualAddresses(t.from_address, PUNK_6529) &&
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );
}

async function consolidateTransactions(
  walletConsolidations: WalletConsolidation[],
  ownerTransactions: OwnerTransactions[],
  reset?: boolean
) {
  if (reset) {
    ownerTransactions = await fetchAllOwnerTransactions();
  }

  const consolidatedTransactions: ConsolidatedOwnerTransactions[] = [];
  const usedKeys = new Set<string>();

  ownerTransactions.forEach((ot) => {
    const opKey = `${ot.contract}-${ot.season}`;
    if (usedKeys.has(`${ot.wallet.toLowerCase()}-${opKey}`)) {
      return;
    }

    const consolidation = walletConsolidations.find((wc) =>
      wc.wallets.some((w: string) => areEqualAddresses(w, ot.wallet))
    );

    if (!consolidation) {
      const consolidatedOT: ConsolidatedOwnerTransactions = {
        consolidation_key: ot.wallet,
        ...ot
      };
      consolidatedTransactions.push(consolidatedOT);
      usedKeys.add(`${ot.wallet}-${opKey}`);
    } else {
      const consolidationPurchases = ownerTransactions.filter((oot) =>
        consolidation.wallets.some(
          (w: string) =>
            areEqualAddresses(w, oot.wallet) &&
            `${oot.contract}-${oot.season}` === opKey
        )
      );
      if (consolidationPurchases.length > 0) {
        const totals = consolidationPurchases.reduce(
          (acc, cp) => {
            acc.primary_purchases_count += cp.primary_purchases_count;
            acc.primary_purchases_value += cp.primary_purchases_value;
            acc.secondary_purchases_count += cp.secondary_purchases_count;
            acc.secondary_purchases_value += cp.secondary_purchases_value;
            acc.burns += cp.burns;
            acc.sales_value += cp.sales_value;
            acc.sales_count += cp.sales_count;
            acc.airdrops += cp.airdrops;
            acc.transfers_in += cp.transfers_in;
            acc.transfers_out += cp.transfers_out;

            return acc;
          },
          {
            primary_purchases_count: 0,
            primary_purchases_value: 0,
            secondary_purchases_count: 0,
            secondary_purchases_value: 0,
            burns: 0,
            sales_value: 0,
            sales_count: 0,
            airdrops: 0,
            transfers_in: 0,
            transfers_out: 0
          }
        );
        const cTransaction: ConsolidatedOwnerTransactions = {
          consolidation_key: consolidation.key,
          contract: ot.contract,
          season: ot.season,
          ...totals
        };
        consolidatedTransactions.push(cTransaction);
      }
      consolidation.wallets.forEach((w: string) => {
        usedKeys.add(`${w}-${opKey}`);
      });
    }
  });

  return consolidatedTransactions;
}
