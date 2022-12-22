import { GRADIENT_CONTRACT, MANIFOLD, MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { Owner, OwnerMetric, OwnerTags } from './entities/IOwner';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';

export const findOwnerMetrics = async (
  owners: { wallet: string }[],
  startingOwnerMetrics: OwnerMetric[],
  db: any
) => {
  const outdatedMetrics = [...startingOwnerMetrics].filter((ownerMetric) => {
    return !owners.find((o) => areEqualAddresses(o.wallet, ownerMetric.wallet));
  });

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
      const transactionsInCount = [...transactionsIn].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const transactionsOut = [...walletTransactions].filter((wt) =>
        areEqualAddresses(wt.from_address, wallet)
      );
      const transactionsOutCount = [...transactionsOut].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const purchases = [...transactionsIn].filter((t) => t.value > 0);
      const purchasesValue = [...purchases].reduce(
        (sum, transaction) => sum + transaction.value,
        0
      );
      const purchasesCount = [...purchases].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const purchasesPrimary = [...purchases].filter((t) =>
        areEqualAddresses(MANIFOLD, t.from_address)
      );
      const purchasesValuePrimary = [...purchasesPrimary].reduce(
        (sum, transaction) => sum + transaction.value,
        0
      );
      const purchasesCountPrimary = [...purchasesPrimary].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const purchasesSecondary = [...purchases].filter(
        (t) => !areEqualAddresses(MANIFOLD, t.from_address)
      );
      const purchasesValueSecondary = [...purchasesSecondary].reduce(
        (sum, transaction) => sum + transaction.value,
        0
      );
      const purchasesCountSecondary = [...purchasesSecondary].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const sales = [...transactionsOut].filter((t) => t.value > 0);
      const salesValue = [...sales].reduce(
        (sum, transaction) => sum + transaction.value,
        0
      );
      const salesCount = [...sales].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const transfersIn = [...transactionsIn].filter((t) => t.value == 0);
      const transfersInCount = [...transfersIn].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const transfersOut = [...transactionsOut].filter((t) => t.value == 0);
      const transfersOutCount = [...transfersOut].reduce(
        (sum, transaction) => sum + transaction.token_count,
        0
      );
      const ownerMetric: OwnerMetric = {
        created_at: new Date(),
        wallet: wallet,
        balance: transactionsInCount - transactionsOutCount,
        purchases_value: purchasesValue,
        purchases_count: purchasesCount,
        purchases_value_primary: purchasesValuePrimary,
        purchases_count_primary: purchasesCountPrimary,
        purchases_value_secondary: purchasesValueSecondary,
        purchases_count_secondary: purchasesCountSecondary,
        sales_value: salesValue,
        sales_count: salesCount,
        transfers_in: transfersInCount,
        transfers_out: transfersOutCount
      };
      ownerMetrics.push(ownerMetric);
    })
  );

  outdatedMetrics.map((m) => {
    m.balance = 0;
    ownerMetrics.push(m);
  });

  console.log(
    new Date(),
    '[OWNERS METRICS END]',
    `[UNIQUE METRICS ${ownerMetrics.length}]`
  );

  return ownerMetrics;
};
