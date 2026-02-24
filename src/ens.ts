import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  ENS_TABLE
} from '@/constants';
import {
  fetchEnsRefresh,
  fetchMissingEns,
  fetchMissingEnsNFTDelegation,
  persistENS
} from '@/db';
import { ENS } from '@/entities/IENS';
import { Wallet } from '@/entities/IWallet';
import { findEnsForAddress } from '@/ens-lookup';
import { env } from '@/env';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

const logger = Logger.get('ENS');
const ENS_DISCOVERY_MAX_RETRIES = 5;
const ENS_DISCOVERY_RETRY_BASE_DELAY_MS = 250;

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
  const ensByAddress = new Map(
    results.map((row) => [row.address.toLowerCase(), row.ens] as const)
  );
  return walletAddresses.map((walletAddress) => ({
    address: walletAddress,
    ens: ensByAddress.get(walletAddress.toLowerCase())
  }));
}

async function findExistingEns(ens: ENS[]) {
  logger.info(`[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`);

  const deltaEns: ENS[] = [];

  for (const w of ens) {
    try {
      const display = await findEnsForAddress(w.wallet);
      const newEns: ENS = {
        created_at: new Date(),
        wallet: w.wallet,
        display: display
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

  const finalEns: ENS[] = [];

  await Promise.all(
    wallets.map(async (w) => {
      try {
        const display = await findEnsForAddress(w);
        const newEns: ENS = {
          created_at: new Date(),
          wallet: w,
          display: display
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
  let retries = 0;

  while (true) {
    try {
      const missingEns = await fetchMissingEns(datetime);
      if (missingEns.length === 0) {
        return;
      }

      const newEns = await findNewEns(missingEns);
      if (newEns.length === 0) {
        return;
      }

      await persistENS(newEns);
      retries = 0;
    } catch (e: any) {
      retries += 1;
      logger.error(e);

      if (retries >= ENS_DISCOVERY_MAX_RETRIES) {
        logger.error(
          `[DISCOVER ENS FAILED] [RETRIES ${retries}] [DATETIME ${datetime?.toISOString() ?? 'null'}]`
        );
        throw e;
      }

      const delayMs = ENS_DISCOVERY_RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
      logger.warn(
        `[DISCOVER ENS RETRYING] [ATTEMPT ${retries}/${ENS_DISCOVERY_MAX_RETRIES}] [DELAY_MS ${delayMs}]`
      );
      await Time.millis(delayMs).sleep();
    }
  }
}

export async function discoverEnsDelegations() {
  return discoverEnsNFTDelegation(DELEGATIONS_TABLE);
}

export async function discoverEnsConsolidations() {
  return discoverEnsNFTDelegation(CONSOLIDATIONS_TABLE);
}

async function discoverEnsNFTDelegation(table: string) {
  let retries = 0;

  while (true) {
    try {
      const missingEns = await fetchMissingEnsNFTDelegation(table);
      if (missingEns.length === 0) {
        return;
      }

      const newEns = await findNewEns(missingEns);
      if (newEns.length === 0) {
        return;
      }

      await persistENS(newEns);
      retries = 0;
    } catch (e: any) {
      retries += 1;
      logger.error(e);

      if (retries >= ENS_DISCOVERY_MAX_RETRIES) {
        logger.error(
          `[DISCOVER ENS NFT DELEGATION FAILED] [TABLE ${table}] [RETRIES ${retries}]`
        );
        throw e;
      }

      const delayMs = ENS_DISCOVERY_RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
      logger.warn(
        `[DISCOVER ENS NFT DELEGATION RETRYING] [TABLE ${table}] [ATTEMPT ${retries}/${ENS_DISCOVERY_MAX_RETRIES}] [DELAY_MS ${delayMs}]`
      );
      await Time.millis(delayMs).sleep();
    }
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
