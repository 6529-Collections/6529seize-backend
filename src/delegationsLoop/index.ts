import {
  persistConsolidations,
  fetchLatestConsolidationsBlockNumber,
  retrieveWalletConsolidations
} from '../db';
import { findDelegationTransactions } from '../delegations';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING DELEGATIONS LOOP]');
  await loadEnv();
  await retrieveDelegations();
  // await delegations();
  await unload();
  console.log(new Date(), '[DELEGATIONS LOOP COMPLETE]');
};

export async function retrieveDelegations() {
  const a = await retrieveWalletConsolidations(
    '0x7f3774eadae4beb01919dec7f32a72e417ab5de3'
  );
  const b = await retrieveWalletConsolidations(
    '0xC03E57b6acE9Dd62C84A095E11E494E3C8FD4D42'
  );
  const c = await retrieveWalletConsolidations(
    '0xfd22004806a6846ea67ad883356be810f0428793'
  );
  console.log('prxt', a);
  console.log('coins', b);
  console.log('punk', c);
}

export async function delegations(
  startingBlock?: number,
  latestBlock?: number
) {
  try {
    let startingBlockResolved: number;
    if (startingBlock == undefined) {
      const dbBlock = await fetchLatestConsolidationsBlockNumber();
      startingBlockResolved = dbBlock ? dbBlock : 0;
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findDelegationTransactions(
      startingBlockResolved,
      latestBlock
    );

    await persistConsolidations(response.consolidations);
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
