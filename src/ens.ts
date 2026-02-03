import { Alchemy } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  ENS_TABLE
} from '@/constants';
import { ENS } from './entities/IENS';
import {
  fetchEnsRefresh,
  fetchMissingEns,
  fetchMissingEnsNFTDelegation,
  persistENS
} from './db';
import { Wallet } from './entities/IWallet';
import { sqlExecutor } from './sql-executor';
import { Logger } from './logging';
import { text } from './text';
import { Time } from './time';
import { env } from './env';

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
  initializeAlchemy();
  return alchemy.core.resolveName(ensName);
}

async function findExistingEns(ens: ENS[]) {
  logger.info(`[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`);

  initializeAlchemy();

  const deltaEns: ENS[] = [];

  for (const w of ens) {
    try {
      const newDisplay = await alchemy.core.lookupAddress(w.wallet);
      let newDisplayStr = newDisplay;
      if (newDisplay) {
        newDisplayStr = text.replaceEmojisWithHex(newDisplay);
      }
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: newDisplayStr
      };
      deltaEns.push(newEns);
    } catch (e: any) {
      logger.error(`[ERROR FOR WALLET ${w.wallet}] [${e}]`);
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

export async function findNewEns(wallets: string[]) {
  logger.info(`[PROCESSING NEW ENS FOR ${wallets.length} WALLETS]`);

  initializeAlchemy();
  const finalEns: ENS[] = [];

  await Promise.all(
    wallets.map(async (w) => {
      try {
        const display = await alchemy.core.lookupAddress(w);
        let displayStr = display;
        if (display) {
          displayStr = text.replaceEmojisWithHex(display);
        }
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: displayStr
        };
        finalEns.push(newEns);
      } catch (e: any) {
        logger.error(`[ERROR FOR WALLET ${w}] [${e}]`);
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
  const batch = await fetchEnsRefresh();

  if (batch.length > 0) {
    const delta = await findExistingEns(batch);
    await persistENS(delta);
    return true;
  } else {
    return false;
  }
}

export async function refreshEns() {
  let processing = true;
  const time = Time.now();
  while (
    processing &&
    !time
      .diffFromNow()
      .gte(
        Time.minutes(
          env.getIntOrNull('REFRESH_ENS_VOLUNTARY_QUIT_MINUTES') ?? 14
        )
      )
  ) {
    processing = await refreshEnsLoop();
  }
}

function initializeAlchemy() {
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }
}
