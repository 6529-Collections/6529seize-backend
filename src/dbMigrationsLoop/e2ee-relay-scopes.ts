import { e2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { e2eeDb } from '@/e2ee/e2ee.db';
import { e2eeRecordWriters } from '@/e2ee/relay/e2ee-record-writers';
import {
  E2eeRebuildReport,
  runE2eeRebuild,
  runE2eeStreamVerify
} from '@/e2ee/relay/e2ee-rebuild-run';
import { E2eeStreamVerifyReport } from '@/e2ee/relay/e2ee-stream-verify';
import { e2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import {
  backfillE2eeRecords,
  E2EE_BACKFILL_FAMILIES,
  E2eeBackfillFamily,
  E2eeBackfillReport,
  mysqlE2eeBackfillDb
} from '@/e2ee/relay/e2ee-relay-backfill';
import { e2eeStreamPublisher } from '@/e2ee/relay/e2ee-stream-publisher';

/**
 * Operator-only `dbMigrationsLoop` scopes for the delivery service's relay
 * records (never run by the deploy workflow or the schedule):
 *
 *   {"schema_scope": "e2ee-relay-backfill", "family": "cv"}             dry run
 *   {"schema_scope": "e2ee-relay-backfill", "family": "cv", "live": true,
 *    "after": "<next>", "limit": 200}                                   copy
 *   {"schema_scope": "e2ee-relay-publish", "waves": 500}                drain
 *   {"schema_scope": "e2ee-relay-rebuild", "mode": "verify"}            check
 *   {"schema_scope": "e2ee-relay-rebuild", "mode": "verify-streams",
 *    "after": "<next>", "limit": 200}                                   check, in slices
 *   {"schema_scope": "e2ee-relay-rebuild", "mode": "write"}             rebuild
 *
 * Families run in the order dr, cv, dv, bl, bk. A live backfill needs
 * E2EE_RELAY_MODE mirror or primary. `write` refuses unless every table it
 * fills is empty.
 */
export const E2EE_RELAY_BACKFILL_SCOPE = 'e2ee-relay-backfill';
export const E2EE_RELAY_PUBLISH_SCOPE = 'e2ee-relay-publish';
export const E2EE_RELAY_REBUILD_SCOPE = 'e2ee-relay-rebuild';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_WAVES = 200;
const MAX_WAVES = 5000;

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function parseE2eeRelayBackfillRequest(event: Record<string, unknown>) {
  if (event.live !== undefined && typeof event.live !== 'boolean') {
    throw new Error('live must be true or false');
  }
  const family = event.family;
  if (!E2EE_BACKFILL_FAMILIES.includes(family as E2eeBackfillFamily)) {
    throw new Error(
      `family must be one of ${E2EE_BACKFILL_FAMILIES.join(', ')}`
    );
  }
  if (event.after !== undefined && typeof event.after !== 'string') {
    throw new Error('after must be a string');
  }
  return {
    live: event.live === true,
    family: family as E2eeBackfillFamily,
    after: event.after as string | undefined,
    limit: boundedInteger(event.limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  };
}

export async function runE2eeRelayBackfillScope(
  event: Record<string, unknown>
): Promise<E2eeBackfillReport> {
  const request = parseE2eeRelayBackfillRequest(event);
  if (request.live && e2eeStreamPublisher.mode() === 'off') {
    throw new Error('A live backfill needs E2EE_RELAY_MODE mirror or primary');
  }
  const blobStores = createE2eeBlobStores({ rows: e2eeDb });
  return backfillE2eeRecords(
    {
      db: mysqlE2eeBackfillDb,
      writers: e2eeRecordWriters,
      run: (work) =>
        e2eeStreamPublisher.run(mysqlE2eeBackfillDb, (connection, batch) => {
          if (!batch) throw new Error('E2EE_RELAY_MODE is off');
          return work(connection, batch);
        }),
      blobChunk: (blob, index) =>
        blobStores.forBlob(blob).getChunk(blob.blob_id, index),
      backupObject: (objectKey) => e2eeCiphertextStore.get(objectKey),
      now: () => Date.now()
    },
    request
  );
}

export async function runE2eeRelayPublishScope(
  event: Record<string, unknown>
): Promise<{ waves: number; complete: number }> {
  const waves = boundedInteger(event.waves, 'waves', DEFAULT_WAVES, MAX_WAVES);
  return e2eeStreamPublisher.publishPending(waves);
}

export async function runE2eeRelayRebuildScope(
  event: Record<string, unknown>
): Promise<E2eeRebuildReport | E2eeStreamVerifyReport> {
  const mode = event.mode;
  if (mode === 'verify-streams') {
    if (event.after !== undefined && typeof event.after !== 'string') {
      throw new Error('after must be a string');
    }
    return runE2eeStreamVerify({
      now: Date.now(),
      settings: e2eeRelaySettings(),
      after: event.after as string | undefined,
      limit: boundedInteger(event.limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
    });
  }
  if (mode !== 'verify' && mode !== 'write') {
    throw new Error('mode must be verify, verify-streams or write');
  }
  return runE2eeRebuild({
    mode,
    now: Date.now(),
    settings: e2eeRelaySettings()
  });
}
