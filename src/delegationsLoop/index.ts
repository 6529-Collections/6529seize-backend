import {
  persistConsolidations,
  fetchLatestConsolidationsBlockNumber,
  retrieveWalletConsolidations,
  persistDelegations,
  fetchLatestDelegationsBlockNumber,
  fetchConsolidations,
  fetchProcessedConsolidation,
  persistWalletConsolidations
} from '../db';
import { findDelegationTransactions } from '../delegations';
import { Delegation, Consolidation } from '../entities/IDelegation';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import { WalletConsolidation } from '../entities/IWalletConsolidation';

const logger = Logger.get('DELEGATIONS_LOOP');

export const handler = async (event?: any, context?: any) => {
  await loadEnv([Delegation, Consolidation, WalletConsolidation]);
  const force = process.env.DELEGATIONS_RESET == 'true';
  logger.info(`[RUNNING] [FORCE ${force}]`);
  await delegations(force ? 0 : undefined);
  await consolidateWallets();
  await unload();
  logger.info('[COMPLETE]');
};

export async function retrieveConsolidations() {
  const a = await retrieveWalletConsolidations(
    '0x7f3774eadae4beb01919dec7f32a72e417ab5de3'
  );
  const b = await retrieveWalletConsolidations(
    '0xC03E57b6acE9Dd62C84A095E11E494E3C8FD4D42'
  );
  const c = await retrieveWalletConsolidations(
    '0xfd22004806a6846ea67ad883356be810f0428793'
  );
  const d = await retrieveWalletConsolidations(
    '0xFe49A85E98941F1A115aCD4bEB98521023a25802'
  );
  logger.info(`prxt ${JSON.stringify(a)}`);
  logger.info(`coins ${JSON.stringify(b)}`);
  logger.info(`punk ${JSON.stringify(c)}`);
  logger.info(`better_phoebe ${JSON.stringify(d)}`);
}

export async function delegations(
  startingBlock?: number,
  latestBlock?: number
) {
  try {
    let startingBlockResolved: number;
    if (startingBlock == undefined) {
      const consolidationBlock = await fetchLatestConsolidationsBlockNumber();
      const delegationBlock = await fetchLatestDelegationsBlockNumber();
      startingBlockResolved =
        consolidationBlock && delegationBlock
          ? Math.min(consolidationBlock, delegationBlock)
          : 0;
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findDelegationTransactions(
      startingBlockResolved,
      latestBlock
    );

    await persistConsolidations(
      process.env.DELEGATIONS_RESET == 'true',
      response.consolidations
    );
    await persistDelegations(
      process.env.DELEGATIONS_RESET == 'true',
      response.registrations,
      response.revocation
    );
  } catch (e: any) {
    logger.error('[ETIMEDOUT!] [RETRYING PROCESS]', e);
    await delegations(startingBlock, latestBlock);
  }
}

async function consolidateWallets() {
  const wallets = await fetchConsolidations();

  const processedWallets = new Set<string>();
  const walletConsolidations: WalletConsolidation[] = [];

  for (const wallet of wallets) {
    if (processedWallets.has(wallet.toLowerCase())) continue;

    const consolidations = await retrieveWalletConsolidations(wallet);
    const processedConsolidation = await fetchProcessedConsolidation(
      consolidations
    );

    walletConsolidations.push(processedConsolidation);
    processedConsolidation.wallets.forEach((w: string) =>
      processedWallets.add(w)
    );
  }

  await persistWalletConsolidations(walletConsolidations);
}
