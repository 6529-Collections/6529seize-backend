import {
  persistConsolidations,
  fetchLatestConsolidationsBlockNumber,
  retrieveWalletConsolidations,
  persistDelegations,
  fetchLatestDelegationsBlockNumber
} from '../db';
import { findDelegationTransactions } from '../delegations';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  await loadEnv();
  // await retrieveConsolidations();
  const force = process.env.DELEGATIONS_RESET == 'true';
  console.log('[RUNNING DELEGATIONS LOOP]', `[FORCE ${force}]`);
  await delegations(force ? 0 : undefined);
  await unload();
  console.log('[DELEGATIONS LOOP COMPLETE]');
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
  console.log('prxt', a);
  console.log('coins', b);
  console.log('punk', c);
  console.log('better_phoebe', d);
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
      response.delegations
    );
  } catch (e: any) {
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      '[ETIMEDOUT!]',
      e,
      '[RETRYING PROCESS]'
    );
    await delegations(startingBlock, latestBlock);
  }
}
