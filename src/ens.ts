import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, ENS_ADDRESS, PUNK_6529 } from './constants';
import { ENS } from './entities/IENS';

const alchemy = new Alchemy(ALCHEMY_SETTINGS);

export const findExistingEns = async (ens: ENS[]) => {
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
};

export const findNewEns = async (wallets: string[]) => {
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
};
