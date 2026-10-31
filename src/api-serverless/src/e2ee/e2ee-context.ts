import { randomBytes, randomInt } from 'node:crypto';
import { ethers } from 'ethers';
import { E2eeEventPublisher, e2eeEventPublisher } from '@/api/e2ee/e2ee-events';
import type { DirectMessageAdmissionService } from '@/api/direct-messages/direct-message-admission.service';
import { directMessageAdmissionService } from '@/api/direct-messages/direct-message-admission.instance';
import { verifyContractWalletSignatureHash } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  E2EE_LAST_SEEN_UPDATE_INTERVAL_MS,
  E2EE_RETENTION,
  E2eeRateLimit
} from '@/e2ee/e2ee.constants';
import { E2eeDb, e2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import {
  createE2eeBlobStores,
  deleteStoredE2eeBlobs,
  E2eeBlobStores
} from '@/e2ee/e2ee-blob-stores';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { isE2eeAttachmentsEnabled } from '@/e2ee/e2ee-flag';
import { E2eeContractWalletVerifier } from '@/e2ee/e2ee-grant';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { identitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';

const logger = Logger.get('E2EE');

export interface E2eeServiceDeps {
  readonly db: E2eeDb;
  readonly events: E2eeEventPublisher;
  readonly contractWalletVerifier: E2eeContractWalletVerifier;
  readonly resolveWalletProfileId: (wallet: string) => Promise<string | null>;
  readonly now: () => number;
  readonly random: () => number;
  readonly randomHex: (bytes: number) => string;
  /** E2EE_ATTACHMENTS_ENABLED: whether blob routes accept or serve chunks. */
  readonly attachmentsEnabled: () => boolean;
  /** Attachment chunk storage (E2EE_BLOB_STORE: MySQL or S3). */
  readonly blobStores: E2eeBlobStores;
  /**
   * The platform's shared inbound DM admission (blocks, DM policy, group
   * membership), the same rules legacy DMs use.
   */
  readonly admission: Pick<DirectMessageAdmissionService, 'evaluate'>;
}

/** Ethereum mainnet EIP-1271 checks (contract section 2.2 step 3). */
export const mainnetContractWalletVerifier: E2eeContractWalletVerifier = {
  async hasCode(wallet: string): Promise<boolean> {
    const code = await getEthereumRpcProvider(1).getCode(
      ethers.getAddress(wallet)
    );
    return !!code && code !== '0x';
  },
  isValidSignature(wallet: string, hash: string, signature: string) {
    return verifyContractWalletSignatureHash({
      address: wallet,
      chainId: 1,
      messageHash: hash,
      signature
    });
  }
};

export const defaultE2eeServiceDeps: E2eeServiceDeps = {
  db: e2eeDb,
  events: e2eeEventPublisher,
  contractWalletVerifier: mainnetContractWalletVerifier,
  resolveWalletProfileId: (wallet) => identitiesDb.getProfileIdByWallet(wallet),
  now: () => Date.now(),
  // Uniform [0, 1) from the CSPRNG (used for pruning odds and jitter).
  random: () => randomInt(0, 0x100000000) / 0x100000000,
  randomHex: (bytes) => `0x${randomBytes(bytes).toString('hex')}`,
  attachmentsEnabled: () => isE2eeAttachmentsEnabled(),
  blobStores: createE2eeBlobStores({ rows: e2eeDb }),
  admission: directMessageAdmissionService
};

export function nowSeconds(deps: E2eeServiceDeps): number {
  return Math.floor(deps.now() / 1000);
}

export function isActiveDevice(
  device: E2eeDeviceRow,
  atSeconds: number
): boolean {
  return device.revoked_at === null && device.expires_at_seconds > atSeconds;
}

/** The device must be an active (not revoked, not expired) own device. */
export async function requireOwnActiveDevice(
  deps: E2eeServiceDeps,
  callerProfileId: string,
  deviceKey: string,
  connection?: ConnectionWrapper<unknown>
): Promise<E2eeDeviceRow> {
  const device = await deps.db.getDevice(deviceKey, connection);
  if (
    device?.profile_id !== callerProfileId ||
    !isActiveDevice(device, nowSeconds(deps))
  ) {
    throw e2eeErrors.notYourDevice();
  }
  if (!connection) {
    try {
      await deps.db.touchDevice(
        deviceKey,
        deps.now(),
        E2EE_LAST_SEEN_UPDATE_INTERVAL_MS
      );
    } catch {
      // last_seen_at is informational.
    }
  }
  return device;
}

function counterKey(limit: E2eeRateLimit, subject: string) {
  return `${limit.scope}:${subject}`;
}

function windowStart(limit: E2eeRateLimit, now: number) {
  return now - (now % limit.windowMs);
}

/** Counts one request against a fixed window; 429 once over the limit. */
export async function enforceE2eeRateLimit(
  deps: E2eeServiceDeps,
  limit: E2eeRateLimit,
  subject: string
): Promise<void> {
  const key = counterKey(limit, subject);
  const hits = await deps.db.hitRateCounters([
    { key, windowStart: windowStart(limit, deps.now()) }
  ]);
  if ((hits.get(key) ?? 0) > limit.limit) throw e2eeErrors.rateLimited();
}

/** Adds `bytes` to a per-subject byte budget; 429 once over the budget. */
export async function enforceE2eeByteBudget(
  deps: E2eeServiceDeps,
  limit: E2eeRateLimit,
  subject: string,
  bytes: number
): Promise<void> {
  const key = counterKey(limit, subject);
  const hits = await deps.db.hitRateCounters([
    { key, windowStart: windowStart(limit, deps.now()), amount: bytes }
  ]);
  if ((hits.get(key) ?? 0) > limit.limit) throw e2eeErrors.rateLimited();
}

/** Counts one request per subject; returns the subjects still within limit. */
export async function filterByE2eeRateLimit(
  deps: E2eeServiceDeps,
  limit: E2eeRateLimit,
  subjects: readonly string[]
): Promise<Set<string>> {
  const unique = Array.from(new Set(subjects));
  if (!unique.length) return new Set();
  const start = windowStart(limit, deps.now());
  const hits = await deps.db.hitRateCounters(
    unique.map((subject) => ({
      key: counterKey(limit, subject),
      windowStart: start
    }))
  );
  return new Set(
    unique.filter(
      (subject) => (hits.get(counterKey(limit, subject)) ?? 0) <= limit.limit
    )
  );
}

/** Blob retention runs on every blob upload so storage stays bounded. */
export async function pruneE2eeBlobs(deps: E2eeServiceDeps): Promise<void> {
  try {
    await deps.db.pruneExpiredBlobs(
      deps.now(),
      E2EE_RETENTION.blobBatchSize,
      (blobs) => deleteStoredE2eeBlobs(deps.blobStores, blobs)
    );
  } catch (error) {
    logger.warn(
      `E2EE blob pruning failed: ${(error as Error)?.message ?? 'unknown'}`
    );
  }
}

/** Opportunistic retention (contract 7.2): about one in 100 writes. */
export async function maybePruneE2ee(deps: E2eeServiceDeps): Promise<void> {
  if (deps.random() >= E2EE_RETENTION.probability) return;
  try {
    await deps.db.pruneExpired(deps.now(), (blobs) =>
      deleteStoredE2eeBlobs(deps.blobStores, blobs)
    );
  } catch (error) {
    logger.warn(
      `E2EE retention pruning failed: ${(error as Error)?.message ?? 'unknown'}`
    );
  }
}
