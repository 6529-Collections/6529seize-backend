import {
  E2eeBlobChunkRows,
  E2eeBlobStore,
  E2eeStoredBlobRef
} from '@/e2ee/e2ee-blob-store';
import {
  E2eeBlobS3Config,
  readE2eeBlobStoreSettings
} from '@/e2ee/e2ee-blob-store.config';
import { MysqlE2eeBlobStore } from '@/e2ee/e2ee-blob-store.mysql';
import {
  createE2eeBlobS3Client,
  E2eeBlobS3Client,
  S3E2eeBlobStore
} from '@/e2ee/e2ee-blob-store.s3';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { Logger } from '@/logging';

type Env = Readonly<Record<string, string | undefined>>;

const logger = Logger.get('E2EE_BLOB_STORES');

/** Picks the store for new blobs and for each existing blob. */
export interface E2eeBlobStores {
  /** The store new blobs use; 503 when the configuration is invalid. */
  forNewBlob(): E2eeBlobStore;
  /** The store that holds this blob's chunks; 503 when it is unavailable. */
  forBlob(blob: { readonly storage?: string | null }): E2eeBlobStore;
}

export interface E2eeBlobStoresDeps {
  readonly rows: E2eeBlobChunkRows;
  /** Read on every call: Lambda secrets are loaded after module import. */
  readonly env?: () => Env;
  readonly s3Client?: (region: string) => E2eeBlobS3Client;
}

export function createE2eeBlobStores(deps: E2eeBlobStoresDeps): E2eeBlobStores {
  const mysql = new MysqlE2eeBlobStore(deps.rows);
  const readEnv = deps.env ?? (() => process.env);
  const newClient = deps.s3Client ?? createE2eeBlobS3Client;
  const clients = new Map<string, E2eeBlobS3Client>();
  let s3Store: {
    readonly key: string;
    readonly store: S3E2eeBlobStore;
  } | null = null;
  let reportedProblems = '';

  function settings() {
    const current = readE2eeBlobStoreSettings(readEnv());
    const problems = current.problems.join('; ');
    if (problems && problems !== reportedProblems) {
      logger.error(`[E2EE BLOB STORAGE MISCONFIGURED] ${problems}`);
    }
    reportedProblems = problems;
    return current;
  }

  function s3For(config: E2eeBlobS3Config | null): S3E2eeBlobStore {
    if (!config) throw e2eeErrors.storageUnavailable();
    const key = `${config.region}|${config.bucket}|${config.prefix}`;
    if (s3Store?.key !== key) {
      let client = clients.get(config.region);
      if (!client) {
        client = newClient(config.region);
        clients.set(config.region, client);
      }
      s3Store = { key, store: new S3E2eeBlobStore(config, client, deps.rows) };
    }
    return s3Store.store;
  }

  function byStorage(storage: string): E2eeBlobStore {
    if (storage === 'mysql') return mysql;
    if (storage === 's3') return s3For(settings().s3);
    logger.error(`[E2EE BLOB STORAGE UNKNOWN] ${storage}`);
    throw e2eeErrors.storageUnavailable();
  }

  return {
    forNewBlob() {
      const storage = settings().writeStorage;
      if (!storage) throw e2eeErrors.storageUnavailable();
      return byStorage(storage);
    },
    forBlob(blob) {
      return byStorage(blob.storage ?? 'mysql');
    }
  };
}

/**
 * Deletes the stored bytes of expired blobs, store by store. Returns the ids
 * whose bytes are gone, so only their rows are deleted; a store that fails
 * keeps its blobs' rows for the next retention pass instead of orphaning
 * objects.
 */
export async function deleteStoredE2eeBlobs(
  stores: E2eeBlobStores,
  blobs: readonly (E2eeStoredBlobRef & { readonly storage?: string | null })[]
): Promise<string[]> {
  const byStorage = new Map<string, (typeof blobs)[number][]>();
  for (const blob of blobs) {
    const storage = blob.storage ?? 'mysql';
    byStorage.set(storage, [...(byStorage.get(storage) ?? []), blob]);
  }
  const deleted: string[] = [];
  for (const [storage, group] of Array.from(byStorage.entries())) {
    try {
      await stores.forBlob({ storage }).deleteBlobs(group);
      deleted.push(...group.map((blob) => blob.blob_id));
    } catch (error) {
      logger.warn(
        `[E2EE BLOB DELETE FAILED] [STORAGE ${storage}] [BLOBS ${group.length}] ${
          (error as Error)?.message ?? 'unknown'
        }`
      );
    }
  }
  return deleted;
}
