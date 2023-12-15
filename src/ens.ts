import { Alchemy } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  ENS_TABLE
} from './constants';
import { ENS } from './entities/IENS';
import {
  fetchEnsRefresh,
  persistENS,
  fetchMissingEns,
  fetchBrokenEnsRefresh,
  fetchMissingEnsNFTDelegation
} from './db';
import { Wallet } from './entities/IWallet';
import { sqlExecutor } from './sql-executor';
import { Logger } from './logging';

const logger = Logger.get('ENS');

let alchemy: Alchemy;

export async function getPrediscoveredEnsNames(
  walletAddresses: string[]
): Promise<Wallet[]> {
  if (!walletAddresses.length) {
    return [];
  }
  const results: Wallet[] = await sqlExecutor.execute(
    `SELECT wallet as address, display as ens FROM ${ENS_TABLE} WHERE LOWER(wallet) IN (:walletAddresses)`,
    {
      walletAddresses: walletAddresses.map((walletAddress) =>
        walletAddress.toLowerCase()
      )
    }
  );
  return walletAddresses.map((walletAddress) => ({
    address: walletAddress,
    ens: results.find((row) => row.address === walletAddress)?.ens
  }));
}

export async function reverseResolveEnsName(
  ensName: string
): Promise<string | null> {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });
  return alchemy.core.resolveName(ensName);
}

async function findExistingEns(ens: ENS[]) {
  logger.info(`[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`);

  const deltaEns: ENS[] = [];

  for (const w of ens) {
    try {
      const newDisplay = await alchemy.core.lookupAddress(w.wallet);
      let newDisplayStr = newDisplay;
      if (newDisplay) {
        newDisplayStr = replaceEmojisWithHex(newDisplay);
      }
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: newDisplayStr
      };
      deltaEns.push(newEns);
    } catch (e: any) {
      logger.error(`[ERROR FOR WALLET ${w.wallet}]`, e);
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: null
      };
      deltaEns.push(newEns);
    }
  }

  logger.info(`[FOUND ${deltaEns.length} DELTA ENS]`);

  return deltaEns;
}

async function findNewEns(wallets: string[]) {
  logger.info(`[PROCESSING NEW ENS FOR ${wallets.length} WALLETS]`);

  const finalEns: ENS[] = [];

  await Promise.all(
    wallets.map(async (w) => {
      try {
        const display = await alchemy.core.lookupAddress(w);
        let displayStr = display;
        if (display) {
          displayStr = replaceEmojisWithHex(display);
        }
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: displayStr
        };
        finalEns.push(newEns);
      } catch (e: any) {
        logger.error(`[ERROR FOR WALLET ${w}]`, e);
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: null
        };
        finalEns.push(newEns);
      }
    })
  );

  logger.info(`[FOUND ${finalEns.length} NEW ENS]`);

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
    logger.error(e);
    await discoverEns(datetime);
  }
}

export async function discoverEnsDelegations() {
  return discoverEnsNFTDelegation(DELEGATIONS_TABLE);
}

export async function discoverEnsConsolidations() {
  return discoverEnsNFTDelegation(CONSOLIDATIONS_TABLE);
}

async function discoverEnsNFTDelegation(table: string) {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  try {
    const missingEns = await fetchMissingEnsNFTDelegation(table);
    if (missingEns.length > 0) {
      const newEns = await findNewEns(missingEns);
      if (newEns.length > 0) {
        await persistENS(newEns);
        await discoverEnsDelegations();
      }
    }
  } catch (e: any) {
    logger.error(e);
    await discoverEnsDelegations();
  }
}

async function refreshEnsLoop() {
  let batch: ENS[];
  if (process.env.REFRESH_BROKEN_ENS === 'true') {
    logger.info(`[REFRESH ENS LOOP] [REFRESHING BROKEN ENS]`);
    batch = await fetchBrokenEnsRefresh();
  } else {
    batch = await fetchEnsRefresh();
  }

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

function replaceEmojisWithHex(inputString: string) {
  return inputString.replace(/[\u{1F300}-\u{1F6FF}]/gu, (match: string) => {
    const codePoint = match.codePointAt(0);
    if (codePoint) {
      const emojiHex = codePoint.toString(16).toUpperCase();
      return `U+${emojiHex}`;
    }
    return match;
  });
}
