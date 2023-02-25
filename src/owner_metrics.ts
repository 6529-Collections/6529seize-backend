import {
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEMES_CONTRACT,
  PUNK_6529
} from './constants';
import { OwnerMetric } from './entities/IOwner';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import {
  persistOwnerMetrics,
  fetchWalletTransactions,
  fetchDistinctOwnerWallets,
  fetchLastOwnerMetrics,
  fetchTransactionsFromDate
} from './db';

export const findOwnerMetrics = async (reset?: boolean) => {
  const lastMetricsDate = await fetchLastOwnerMetrics();

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

  console.log(
    '[OWNERS METRICS]',
    `[OWNERS ${owners.length}]`,
    `[lastMetricsDate ${lastMetricsDate}]`,
    `[transactionReference ${transactionReference}]`,
    `[RESET ${reset}]`
  );

  const ownerMetrics: OwnerMetric[] = [];

  await Promise.all(
    owners.map(async (owner) => {
      const wallet = owner.wallet;

      const walletTransactions: Transaction[] = await fetchWalletTransactions(
        wallet
      );

      if (walletTransactions.length > 0) {
        const transactionsIn = [...walletTransactions].filter((wt) =>
          areEqualAddresses(wt.to_address, wallet)
        );
        const transactionsOut = [...walletTransactions].filter((wt) =>
          areEqualAddresses(wt.from_address, wallet)
        );
        const memesTransactionsIn = [...transactionsIn].filter((tr) =>
          areEqualAddresses(tr.contract, MEMES_CONTRACT)
        );
        const memesTransactionsOut = [...transactionsOut].filter((tr) =>
          areEqualAddresses(tr.contract, MEMES_CONTRACT)
        );
        const memesTransactionsInSeason1 = [...memesTransactionsIn].filter(
          (tr) => 47 >= tr.token_id
        );
        const memesTransactionsOutSeason1 = [...memesTransactionsOut].filter(
          (tr) => 47 >= tr.token_id
        );
        const memesTransactionsInSeason2 = [...memesTransactionsIn].filter(
          (tr) => tr.token_id >= 48
        );
        const memesTransactionsOutSeason2 = [...memesTransactionsOut].filter(
          (tr) => tr.token_id >= 48
        );
        const gradientsTransactionsIn = [...transactionsIn].filter((tr) =>
          areEqualAddresses(tr.contract, GRADIENT_CONTRACT)
        );
        const gradientsTransactionsOut = [...transactionsOut].filter((tr) =>
          areEqualAddresses(tr.contract, GRADIENT_CONTRACT)
        );

        const purchases = [...transactionsIn].filter((t) => t.value > 0);
        const purchasesMemes = [...purchases].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const purchasesMemesS1 = [...purchasesMemes].filter(
          (t) => 47 >= t.token_id
        );
        const purchasesMemesS2 = [...purchasesMemes].filter(
          (t) => t.token_id >= 48
        );
        const purchasesGradients = [...purchases].filter((t) =>
          areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const purchasesPrimary = [...purchases].filter((t) =>
          areEqualAddresses(MANIFOLD, t.from_address)
        );
        const purchasesPrimaryMemes = [...purchasesPrimary].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const purchasesPrimaryMemesS1 = [...purchasesPrimaryMemes].filter(
          (t) => 47 >= t.token_id
        );
        const purchasesPrimaryMemesS2 = [...purchasesPrimaryMemes].filter(
          (t) => t.token_id >= 48
        );
        const purchasesPrimaryGradients = [...purchasesPrimary].filter((t) =>
          areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const purchasesSecondary = [...purchases].filter(
          (t) => !areEqualAddresses(MANIFOLD, t.from_address)
        );
        const purchasesSecondaryMemes = [...purchasesSecondary].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const purchasesSecondaryMemesS1 = [...purchasesSecondaryMemes].filter(
          (t) => 47 >= t.token_id
        );
        const purchasesSecondaryMemesS2 = [...purchasesSecondaryMemes].filter(
          (t) => t.token_id >= 48
        );
        const purchasesSecondaryGradients = [...purchasesSecondary].filter(
          (t) => areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const sales = [...transactionsOut].filter(
          (t) => t.value > 0 && !isPunkGradient(t)
        );
        const salesMemes = [...sales].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const salesMemesS1 = [...salesMemes].filter((t) => 47 >= t.token_id);
        const salesMemesS2 = [...salesMemes].filter((t) => t.token_id >= 48);
        const salesGradients = [...sales].filter((t) =>
          areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const transfersIn = [...transactionsIn].filter((t) => t.value == 0);
        const transfersInMemes = [...transfersIn].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const transfersInMemesS1 = [...transfersInMemes].filter(
          (t) => 47 >= t.token_id
        );
        const transfersInMemesS2 = [...transfersInMemes].filter(
          (t) => t.token_id >= 48
        );
        const transfersInGradients = [...transfersIn].filter((t) =>
          areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const transfersOut = [...transactionsOut].filter(
          (t) => t.value == 0 || isPunkGradient(t)
        );

        const transfersOutMemes = [...transfersOut].filter((t) =>
          areEqualAddresses(t.contract, MEMES_CONTRACT)
        );
        const transfersOutMemesS1 = [...transfersOutMemes].filter(
          (t) => 47 >= t.token_id
        );
        const transfersOutMemesS2 = [...transfersOutMemes].filter(
          (t) => t.token_id >= 48
        );
        const transfersOutGradients = [...transfersOut].filter((t) =>
          areEqualAddresses(t.contract, GRADIENT_CONTRACT)
        );

        const ownerMetric: OwnerMetric = {
          created_at: new Date(),
          wallet: wallet,
          balance: getCount(transactionsIn) - getCount(transactionsOut),
          memes_balance:
            getCount(memesTransactionsIn) - getCount(memesTransactionsOut),
          memes_balance_season1:
            getCount(memesTransactionsInSeason1) -
            getCount(memesTransactionsOutSeason1),
          memes_balance_season2:
            getCount(memesTransactionsInSeason2) -
            getCount(memesTransactionsOutSeason2),
          gradients_balance:
            getCount(gradientsTransactionsIn) -
            getCount(gradientsTransactionsOut),
          purchases_value: getValue(purchases),
          purchases_count: getCount(purchases),
          purchases_value_memes: getValue(purchasesMemes),
          purchases_count_memes: getCount(purchasesMemes),
          purchases_value_memes_season1: getValue(purchasesMemesS1),
          purchases_count_memes_season1: getCount(purchasesMemesS1),
          purchases_value_memes_season2: getValue(purchasesMemesS2),
          purchases_count_memes_season2: getCount(purchasesMemesS2),
          purchases_value_gradients: getValue(purchasesGradients),
          purchases_count_gradients: getCount(purchasesGradients),
          purchases_value_primary: getValue(purchasesPrimary),
          purchases_count_primary: getCount(purchasesPrimary),
          purchases_value_primary_memes: getValue(purchasesPrimaryMemes),
          purchases_count_primary_memes: getCount(purchasesPrimaryMemes),
          purchases_value_primary_memes_season1: getValue(
            purchasesPrimaryMemesS1
          ),
          purchases_count_primary_memes_season1: getCount(
            purchasesPrimaryMemesS1
          ),
          purchases_value_primary_memes_season2: getValue(
            purchasesPrimaryMemesS2
          ),
          purchases_count_primary_memes_season2: getCount(
            purchasesPrimaryMemesS2
          ),
          purchases_value_primary_gradients: getValue(
            purchasesPrimaryGradients
          ),
          purchases_count_primary_gradients: getCount(
            purchasesPrimaryGradients
          ),
          purchases_value_secondary: getValue(purchasesSecondary),
          purchases_count_secondary: getCount(purchasesSecondary),
          purchases_value_secondary_memes: getValue(purchasesSecondaryMemes),
          purchases_count_secondary_memes: getCount(purchasesSecondaryMemes),
          purchases_value_secondary_memes_season1: getValue(
            purchasesSecondaryMemesS1
          ),
          purchases_count_secondary_memes_season1: getCount(
            purchasesSecondaryMemesS1
          ),
          purchases_value_secondary_memes_season2: getValue(
            purchasesSecondaryMemesS2
          ),
          purchases_count_secondary_memes_season2: getCount(
            purchasesSecondaryMemesS2
          ),
          purchases_value_secondary_gradients: getValue(
            purchasesSecondaryGradients
          ),
          purchases_count_secondary_gradients: getCount(
            purchasesSecondaryGradients
          ),
          sales_value: getValue(sales),
          sales_count: getCount(sales),
          sales_value_memes: getValue(salesMemes),
          sales_count_memes: getCount(salesMemes),
          sales_value_memes_season1: getValue(salesMemesS1),
          sales_count_memes_season1: getCount(salesMemesS1),
          sales_value_memes_season2: getValue(salesMemesS2),
          sales_count_memes_season2: getCount(salesMemesS2),
          sales_value_gradients: getValue(salesGradients),
          sales_count_gradients: getCount(salesGradients),
          transfers_in: getCount(transfersIn),
          transfers_in_memes: getCount(transfersInMemes),
          transfers_in_memes_season1: getCount(transfersInMemesS1),
          transfers_in_memes_season2: getCount(transfersInMemesS2),
          transfers_in_gradients: getCount(transfersInGradients),
          transfers_out: getCount(transfersOut),
          transfers_out_memes: getCount(transfersOutMemes),
          transfers_out_memes_season1: getCount(transfersOutMemesS1),
          transfers_out_memes_season2: getCount(transfersOutMemesS2),
          transfers_out_gradients: getCount(transfersOutGradients),
          transaction_reference: transactionReference
        };
        ownerMetrics.push(ownerMetric);
      }
    })
  );

  console.log('[OWNERS METRICS]', `[DELTA ${ownerMetrics.length}]`);

  await persistOwnerMetrics(ownerMetrics, reset);
  return ownerMetrics;
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
