import { GRADIENT_CONTRACT, MANIFOLD, MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { Owner, OwnerMetric, OwnerTags } from './entities/IOwner';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';

export const findOwnerMetrics = async (
  owners: { wallet: string }[],
  startingOwnerMetrics: OwnerMetric[],
  db: any,
  reset?: boolean
) => {
  let outdatedMetrics: any[];
  if (reset) {
    outdatedMetrics = owners;
  } else {
    outdatedMetrics = [...startingOwnerMetrics].filter((ownerMetric) => {
      return !owners.find((o) =>
        areEqualAddresses(o.wallet, ownerMetric.wallet)
      );
    });
  }

  console.log(
    new Date(),
    '[OWNERS METRICS START]',
    `[UNIQUE OWNERS ${owners.length}]`,
    `[OUTDATED OWNER METRICS ${outdatedMetrics.length}]`
  );

  const ownerMetrics: OwnerMetric[] = [];

  await Promise.all(
    owners.map(async (owner) => {
      const wallet = owner.wallet;

      const walletTransactions: Transaction[] =
        await db.fetchWalletTransactions(wallet);

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
      const purchasesPrimary = [...purchases].filter((t) =>
        areEqualAddresses(MANIFOLD, t.from_address)
      );
      const purchasesSecondary = [...purchases].filter(
        (t) => !areEqualAddresses(MANIFOLD, t.from_address)
      );
      const sales = [...transactionsOut].filter((t) => t.value > 0);
      const transfersIn = [...transactionsIn].filter((t) => t.value == 0);
      const transfersOut = [...transactionsOut].filter((t) => t.value == 0);

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
        purchases_value_primary: getValue(purchasesPrimary),
        purchases_count_primary: getCount(purchasesPrimary),
        purchases_value_secondary: getValue(purchasesSecondary),
        purchases_count_secondary: getCount(purchasesSecondary),
        sales_value: getValue(sales),
        sales_count: getCount(sales),
        transfers_in: getCount(transfersIn),
        transfers_out: getCount(transfersOut)
      };
      ownerMetrics.push(ownerMetric);
    })
  );

  if (!reset) {
    outdatedMetrics.map((m) => {
      m.balance = 0;
      ownerMetrics.push(m);
    });
  }

  console.log(
    new Date(),
    '[OWNERS METRICS END]',
    `[UNIQUE METRICS ${ownerMetrics.length}]`
  );

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
