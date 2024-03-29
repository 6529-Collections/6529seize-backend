import { MEMES_MINT_PRICE, TEAM_TABLE } from '../constants';
import {
  fetchWalletConsolidationKeysViewForWallet,
  getDataSource
} from '../db';
import { fetchDelegatorForAirdropAddress } from '../delegationsLoop/db.delegations';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { insertWithoutUpdate } from '../orm_helpers';
import { sqlExecutor } from '../sql-executor';

const logger = Logger.get('DB_SUBSCRIPTIONS');

export async function fetchAllAutoSubscriptions() {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .find({ where: { automatic: true } });
}

export async function fetchAllNftSubscriptions(contract: string, id: number) {
  return await getDataSource()
    .getRepository(NFTSubscription)
    .find({ where: { contract: contract, token_id: id } });
}

export async function fetchAllNftSubscriptionBalances() {
  return await getDataSource().getRepository(SubscriptionBalance).find();
}

export async function fetchNftFinalSubscriptionForConsolidationKey(
  contract: string,
  token_id: number,
  consolidation_key: string
) {
  return await getDataSource().getRepository(NFTFinalSubscription).find({
    where: {
      contract,
      token_id,
      consolidation_key
    }
  });
}

export async function fetchSubscriptionBalanceForConsolidationKey(
  consolidation_key: string,
  manager?: any
) {
  let connection = manager ?? getDataSource();
  return await connection
    .getRepository(SubscriptionBalance)
    .findOne({ where: { consolidation_key } });
}

export async function persistSubscriptions(
  subscriptions: NFTSubscription[],
  logs: SubscriptionLog[]
) {
  await getDataSource().transaction(async (manager) => {
    await getDataSource()
      .getRepository(NFTSubscription)
      .upsert(subscriptions, ['consolidation_key', 'contract', 'token_id']);
    await manager.getRepository(SubscriptionLog).insert(logs);
  });
}

export async function persistNFTFinalSubscriptions(
  contract: string,
  token_id: number,
  upload: NFTFinalSubscriptionUpload,
  subscriptions: NFTFinalSubscription[],
  logs: SubscriptionLog[]
) {
  await getDataSource().transaction(async (manager) => {
    const finalRepo = manager.getRepository(NFTFinalSubscription);
    const uploadRepo = manager.getRepository(NFTFinalSubscriptionUpload);
    await finalRepo.delete({
      contract: contract,
      token_id: token_id
    });
    await insertWithoutUpdate(finalRepo, subscriptions);
    await uploadRepo.upsert(upload, ['date', 'contract', 'token_id']);

    await manager.getRepository(SubscriptionLog).insert(logs);
  });
}

export async function redeemSubscriptionAirdrop(
  transaction: Transaction,
  connection: any
) {
  // TODO: REMOVE THIS
  transaction.to_address = '0xfe49a85e98941f1a115acd4beb98521023a25802';

  logger.info(
    `[REDEEMING SUBSCRIPTION AIRDROP] : [Transaction ${transaction.transaction}]`
  );

  const mappedAddress =
    (await fetchDelegatorForAirdropAddress(transaction.to_address)) ??
    transaction.to_address;

  console.log('hi i am mapped address', mappedAddress);

  const consolidationKey =
    (await fetchWalletConsolidationKeysViewForWallet([mappedAddress]))[0]
      .consolidation_key ?? mappedAddress;

  const subscription = await fetchNftFinalSubscriptionForConsolidationKey(
    transaction.contract,
    transaction.token_id,
    consolidationKey
  );

  const team = (
    await sqlExecutor.execute(
      `SELECT * FROM ${TEAM_TABLE} WHERE LOWER(wallet) = '${transaction.to_address}'`
    )
  )[0];

  if (team) {
    logger.info(
      `[Subscription is for team member ${team.wallet}] : [Transaction ${transaction.transaction}]`
    );
    return;
  }
  if (!subscription) {
    logger.warn(
      `[No subscription found for consolidation key ${consolidationKey}] : [Transaction ${transaction.transaction}] : [Address ${transaction.to_address}]`
    );
    return;
  }
  let balance = await fetchSubscriptionBalanceForConsolidationKey(
    consolidationKey,
    connection.connection.manager
  );
  if (!balance) {
    logger.error(
      `[No balance found for consolidation key ${consolidationKey}] :[Transaction ${transaction.transaction}]`
    );
    balance = {
      consolidation_key: consolidationKey,
      balance: 0
    };
  }
  if (MEMES_MINT_PRICE > balance.balance) {
    logger.error(
      `[Insufficient balance for consolidation key ${consolidationKey}] :[Transaction ${transaction.transaction}]`
    );
  }

  let balanceAfter = balance.balance ?? 0 - MEMES_MINT_PRICE;
  balanceAfter = Math.round(balanceAfter * 100000) / 100000;
  balance.balance = balanceAfter;

  const manager = connection.connection.manager;
  await manager.getRepository(SubscriptionBalance).save(balance);

  const redeemedSubscription: RedeemedSubscription = {
    contract: transaction.contract,
    token_id: transaction.token_id,
    address: transaction.to_address,
    transaction: transaction.transaction,
    transaction_date: transaction.transaction_date,
    consolidation_key: consolidationKey,
    value: MEMES_MINT_PRICE,
    balance_after: balanceAfter
  };

  await manager.getRepository(RedeemedSubscription).save(redeemedSubscription);
}
