import { formatEther } from 'ethers';
import { DROP_FORGE_FUNDING_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { DropForgeFundingEntity } from '@/entities/IDropForgeSettings';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  EthereumLaunchChain,
  rpcWithDeadline
} from '@/drop-forge/drop-forge.chain';
import { ForgeDelivery, wakeDropForge } from '@/drop-forge/drop-forge.wake';
import { postForgeReport } from '@/drop-forge/drop-forge.notifier';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { Logger } from '@/logging';

export async function registerForgeFunding(
  config: DropForgeConfig,
  wallet: string,
  hash: string
): Promise<void> {
  const tx = await rpcWithDeadline(
    getEthereumRpcProvider(config.chainId).getTransaction(hash)
  );
  if (!tx)
    throw new LaunchSafetyError(
      'Funding transaction is not visible yet; retain the hash and retry'
    );
  const cancelled =
    tx.to?.toLowerCase() === wallet.toLowerCase() &&
    tx.value === BigInt(0) &&
    tx.data === '0x';
  const deposit =
    tx.to?.toLowerCase() === config.signer.toLowerCase() &&
    tx.value > BigInt(0) &&
    tx.data === '0x';
  if (
    tx.chainId !== BigInt(config.chainId) ||
    tx.from.toLowerCase() !== wallet.toLowerCase()
  )
    throw new LaunchSafetyError(
      'Funding transaction does not match this wallet, chain and operational address'
    );
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const id = `funding:${config.chainId}:${wallet.toLowerCase()}:${tx.nonce}`;
    const existing = await sqlExecutor.oneOrNull<DropForgeFundingEntity>(
      `SELECT * FROM ${DROP_FORGE_FUNDING_TABLE} WHERE id = :id FOR UPDATE`,
      { id },
      { wrappedConnection: connection }
    );
    if (!deposit && !existing)
      throw new LaunchSafetyError(
        'Funding transaction does not match a registered top-up'
      );
    if (existing?.drop_id) return;
    const attempts =
      typeof existing?.attempts === 'string'
        ? (JSON.parse(existing.attempts) as NonNullable<
            DropForgeFundingEntity['attempts']
          >)
        : (existing?.attempts ?? []);
    if (!attempts.some((it) => it.hash === hash.toLowerCase()))
      attempts.push({
        hash: hash.toLowerCase(),
        amount_wei: tx.value.toString(),
        cancelled,
        replaced: !deposit && !cancelled
      });
    if (attempts.length > 20)
      throw new LaunchSafetyError(
        'Funding replacement limit reached; inspect this wallet nonce'
      );
    await sqlExecutor.execute(
      `INSERT INTO ${DROP_FORGE_FUNDING_TABLE} (id, hash, sender, recipient, amount_wei, created_at, attempts) VALUES (:id, :hash, :sender, :recipient, :amount, :now, :attempts) ON DUPLICATE KEY UPDATE attempts = VALUES(attempts)`,
      {
        id,
        hash: hash.toLowerCase(),
        sender: tx.from,
        recipient: config.signer,
        amount: tx.value.toString(),
        now: Date.now(),
        attempts: JSON.stringify(attempts)
      },
      { wrappedConnection: connection }
    );
    await wakeDropForge({ id, revision: 0 });
  });
}

export async function processForgeFunding(
  config: DropForgeConfig,
  delivery: ForgeDelivery
): Promise<void> {
  const row = await sqlExecutor.oneOrNull<DropForgeFundingEntity>(
    `SELECT * FROM ${DROP_FORGE_FUNDING_TABLE} WHERE id = :id`,
    { id: delivery.id },
    { forcePool: DbPoolName.WRITE }
  );
  if (
    !row ||
    !row.id.startsWith(`funding:${config.chainId}:`) ||
    row.recipient.toLowerCase() !== config.signer.toLowerCase()
  )
    throw new LaunchSafetyError(
      'Funding request has not committed or configuration changed'
    );
  if (row.drop_id) return;
  const attempts =
    typeof row.attempts === 'string'
      ? (JSON.parse(row.attempts) as NonNullable<
          DropForgeFundingEntity['attempts']
        >)
      : (row.attempts ?? [
          { hash: row.hash, amount_wei: row.amount_wei, cancelled: false }
        ]);
  const chain = new EthereumLaunchChain(config);
  let winner: {
    attempt: (typeof attempts)[number];
    receipt: NonNullable<Awaited<ReturnType<typeof chain.receipt>>>;
  } | null = null;
  for (const attempt of attempts) {
    const receipt = await chain.receipt(attempt.hash);
    if (
      receipt &&
      receipt.status !== null &&
      receipt.confirmations >= config.confirmations
    ) {
      winner = { attempt, receipt };
      break;
    }
  }
  if (!winner) {
    if (Date.now() - Number(row.created_at) > 86400000)
      throw new LaunchSafetyError(
        'Funding remains unconfirmed after 24 hours; inspect the exact transaction before redrive'
      );
    await wakeDropForge(delivery, false, 60);
    return;
  }
  const { receipt, attempt } = winner;
  const explorer =
    config.chainId === 1
      ? 'https://etherscan.io'
      : 'https://sepolia.etherscan.io';
  const pushes = await sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      const current = await sqlExecutor.oneOrNull<DropForgeFundingEntity>(
        `SELECT * FROM ${DROP_FORGE_FUNDING_TABLE} WHERE id = :id FOR UPDATE`,
        { id: delivery.id },
        { wrappedConnection: connection }
      );
      if (!current || current.drop_id) return [];
      const report = await postForgeReport(
        config,
        fundingReport(row, attempt, receipt.status) +
          ` [Transaction](${explorer}/tx/${attempt.hash})`,
        receipt.status !== 1,
        { connection }
      );
      await sqlExecutor.execute(
        `UPDATE ${DROP_FORGE_FUNDING_TABLE} SET drop_id = :drop WHERE id = :id`,
        { drop: report.drop_id, id: row.id },
        { wrappedConnection: connection }
      );
      return report.pending_push_notification_ids;
    }
  );
  try {
    await sendIdentityPushNotifications(pushes);
  } catch {
    Logger.get('DROP_FORGE_FUNDING').warn(
      'Funding report is durable; push delivery failed'
    );
  }
}

function fundingReport(
  row: DropForgeFundingEntity,
  attempt: NonNullable<DropForgeFundingEntity['attempts']>[number],
  status: number | null
): string {
  if (status !== 1)
    return `Operational wallet top-up transaction reverted from ${row.sender}.`;
  if (attempt.cancelled)
    return `Operational wallet top-up cancelled by ${row.sender}.`;
  if (attempt.replaced)
    return `Operational wallet top-up replaced by a different transaction from ${row.sender}; the operational wallet was not funded by this transaction.`;
  return `Operational wallet top-up confirmed: ${formatEther(attempt.amount_wei)} ETH from ${row.sender} to ${row.recipient}.`;
}
