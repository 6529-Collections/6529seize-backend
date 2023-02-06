import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, ENS_ADDRESS, PUNK_6529 } from './constants';
import { ENS } from './entities/IENS';
import { fetchMissingEns, fetchEnsRefresh, persistENS } from './db';

let alchemy: Alchemy;

async function findExistingEns(ens: ENS[]) {
  console.log(
    new Date(),
    '[ENS EXISTING]',
    `[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`
  );

  const deltaEns: ENS[] = [];

  await Promise.all(
    ens.map(async (w) => {
      const newDisplay = await alchemy.core.lookupAddress(w.wallet);
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: newDisplay
      };
      deltaEns.push(newEns);
    })
  );

  console.log(
    new Date(),
    '[ENS EXISTING]',
    `[FOUND ${deltaEns.length} DELTA ENS]`
  );

  return deltaEns;
}

async function findNewEns(wallets: string[]) {
  console.log(
    new Date(),
    '[ENS NEW]',
    `[PROCESSING NEW ENS FOR ${wallets.length} WALLETS]`
  );

  const finalEns: ENS[] = [];

  await Promise.all(
    wallets.map(async (w) => {
      const display = await alchemy.core.lookupAddress(w);
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w,
        display: display
      };
      finalEns.push(newEns);
    })
  );

  console.log(new Date(), '[ENS NEW]', `[FOUND ${finalEns.length} NEW ENS]`);

  return finalEns;
}

export async function discoverEns(datetime?: Date) {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  try {
    const missingEns = await fetchMissingEns(datetime);
    if (missingEns.length > 0) {
      const newEns = await findNewEns(missingEns);
      await persistENS(newEns);
      await discoverEns(datetime);
    }
  } catch (e: any) {
    console.log(e);
    if (e.message.includes('ETIMEDOUT') || e.message.includes('429')) {
      console.log(
        new Date(),
        '[ENS NEW]',
        '[ETIMEDOUT!]',
        '[RETRYING PROCESS]'
      );
      await discoverEns(datetime);
    }
  }
}

export async function refreshEns() {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  try {
    const startingEns: ENS[] = await fetchEnsRefresh();
    if (startingEns.length > 0) {
      const deltaEns = await findExistingEns(startingEns);
      await persistENS(deltaEns);
      await refreshEns();
    } else {
      console.log(new Date(), '[ENS REFRESH]', '[DONE!]');
    }
  } catch (e: any) {
    if (e.message.includes('ETIMEDOUT') || e.message.includes('429')) {
      console.log(
        new Date(),
        '[ENS EXISTING]',
        '[ETIMEDOUT!]',
        '[RETRYING PROCESS]'
      );
      await refreshEns();
    }
  }
}
