import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, ENS_ADDRESS, PUNK_6529 } from './constants';
import { ENS } from './entities/IENS';
import {
  fetchEnsRefresh,
  persistENS,
  fetchTransactionsFromDate,
  fetchMissingEns
} from './db';

let alchemy: Alchemy;

async function findExistingEns(ens: ENS[]) {
  console.log(
    new Date(),
    '[ENS EXISTING]',
    `[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`
  );

  const deltaEns: ENS[] = [];

  for (const w of ens) {
    try {
      const newDisplay = await alchemy.core.lookupAddress(w.wallet);
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: newDisplay
      };
      deltaEns.push(newEns);
    } catch (e: any) {
      console.log(
        '[ENS EXISTING]',
        `[ERROR FOR WALLET ${w.wallet}]`,
        e.message
      );
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: null
      };
      deltaEns.push(newEns);
    }
  }

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
      try {
        const display = await alchemy.core.lookupAddress(w);
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: display
        };
        finalEns.push(newEns);
      } catch (e: any) {
        console.log('[ENS NEW]', `[ERROR FOR WALLET ${w}]`, e.message);
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: null
        };
        finalEns.push(newEns);
      }
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
      if (newEns.length > 0) {
        await persistENS(newEns);
        await discoverEns(datetime);
      }
    }
  } catch (e: any) {
    console.log(e);
    await discoverEns(datetime);
  }
}

async function refreshEnsLoop() {
  const batch: ENS[] = await fetchEnsRefresh();
  if (batch.length > 0) {
    const delta = await findExistingEns(batch);
    await persistENS(delta);
    return true;
  } else {
    return false;
  }
}

export async function refreshEns() {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  let processing = true;
  while (processing) {
    processing = await refreshEnsLoop();
  }
}
