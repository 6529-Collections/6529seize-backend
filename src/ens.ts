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
const ENS_LOOKUP_CONCURRENCY = 10;

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

async function refreshExistingEnsBatch(
  ens: ENS[],
  shouldStop: () => boolean
): Promise<number> {
  logger.info(`[PROCESSING EXISTING ENS FOR ${ens.length} WALLETS]`);

  const persistChunkSize =
    env.getIntOrNull('REFRESH_ENS_PERSIST_CHUNK_SIZE') ?? 20;
  let deltaEns: ENS[] = [];
  let processed = 0;

  for (const w of ens) {
    if (shouldStop()) {
      logger.info(
        `[REFRESH ENS STOPPING EARLY] [PROCESSED ${processed}] [TOTAL ${ens.length}]`
      );
      break;
    }
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

    processed++;

    if (deltaEns.length >= persistChunkSize) {
      await persistENS(deltaEns);
      deltaEns = [];
    }
  }

  if (deltaEns.length > 0) {
    await persistENS(deltaEns);
  }

  logger.info(
    `[FOUND ${processed} DELTA ENS] [PERSISTED ${processed}] [TOTAL ${ens.length}]`
  );

  return processed;
}

export async function findNewEns(wallets: string[]) {
  logger.info(`[PROCESSING NEW ENS FOR ${wallets.length} WALLETS]`);

  const finalEns: ENS[] = [];

  const concurrency = Math.max(
    1,
    Math.min(ENS_LOOKUP_CONCURRENCY, wallets.length)
  );
  let nextIndex = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= wallets.length) {
        return;
      }

      const w = wallets[index];
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
    }
  });

  await Promise.all(workers);

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

async function refreshEnsLoop(shouldStop: () => boolean) {
  if (shouldStop()) {
    return false;
  }
  const batch = await fetchEnsRefresh();

  if (batch.length > 0) {
    await refreshExistingEnsBatch(batch, shouldStop);
    return true;
  } else {
    return false;
  }
}

export async function refreshEns(getRemainingTimeInMillis?: () => number) {
  let processing = true;
  const time = Time.now();
  const minRemainingMs =
    env.getIntOrNull('REFRESH_ENS_MIN_REMAINING_MS') ?? 60000;
  const voluntaryQuitMinutes =
    env.getIntOrNull('REFRESH_ENS_VOLUNTARY_QUIT_MINUTES') ?? 14;
  const shouldStop = () => {
    if (
      getRemainingTimeInMillis &&
      getRemainingTimeInMillis() <= minRemainingMs
    ) {
      return true;
    }
    return time.diffFromNow().gte(Time.minutes(voluntaryQuitMinutes));
  };
  while (processing && !shouldStop()) {
    processing = await refreshEnsLoop(shouldStop);
  }
}
