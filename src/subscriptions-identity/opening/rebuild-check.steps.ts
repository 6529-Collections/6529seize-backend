import fetch from 'node-fetch';
import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { Logger } from '@/logging';
import {
  RecordLogReader,
  SegmentFetcher
} from '@/signed-records/record-log/record-log-reader';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { sqlExecutor } from '@/sql-executor';
import {
  OPENING_STATE_ID,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import type { JournalBody } from '../timeline/journal';
import { copyLegacyHistory, copyLegacyState } from './legacy-copy';
import {
  Fetcher,
  JournalSource,
  readJournal,
  rebuildIdentityTables
} from './rebuild';

const logger = Logger.get('SUBSCRIPTIONS_REBUILD_CHECK');

/** What the rebuild check's runner passes a step (src/rebuild/manifest.types.ts). */
interface CheckStepContext {
  readonly sources: { readonly files: string | null };
}

/** The files source's base, without a trailing slash. */
function filesBase(files: string): string {
  return files.replace(/\/+$/, '');
}

/** Segment files from the run's files source (`/ipfs/<cid>`, `/ar/<id>`). */
function segmentFetcher(files: string): SegmentFetcher {
  const get = async (path: string): Promise<Buffer> => {
    const response = await fetch(`${filesBase(files)}${path}`);
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }
    return response.buffer();
  };
  return {
    fetchCid: (cid) => get(`/ipfs/${encodeURIComponent(cid)}`),
    fetchArweave: (id) => get(`/ar/${encodeURIComponent(id)}`)
  };
}

/**
 * The opening and history files, by the Arweave URL go-live stored in the
 * journal's opening entry, from the files source's `/ar/<id>`.
 */
export function arweaveFromFiles(files: string): Fetcher {
  return async (uri) => {
    const match = /^https:\/\/arweave\.net\/([A-Za-z0-9_-]+)$/.exec(uri);
    if (!match) {
      throw new Error(`Not an Arweave URL the files source serves: ${uri}`);
    }
    const response = await fetch(`${filesBase(files)}/ar/${match[1]}`);
    if (!response.ok) {
      throw new Error(`GET ${uri} answered ${response.status}`);
    }
    return response.text();
  };
}

/** The journal's lanes of the record log, as the records wave holds them. */
export function recordsWaveJournal(reader: RecordLogReader): JournalSource {
  return {
    async *walk(chain) {
      for await (const { entry } of reader.walk(chain)) {
        yield { entry };
      }
    }
  };
}

/**
 * The switch the journal records: the opening entry of the loaded opening
 * is written at the switch time and names the published files, so setting
 * that time and those URLs back makes the rebuilt tables the truth again
 * exactly as they were. Nothing is written to the record log. A suspended
 * opening stays suspended.
 */
async function restoreRecordedSwitch(
  bodies: readonly JournalBody[],
  openingSha256: string
): Promise<number | null> {
  const opening = bodies
    .filter(
      (body) =>
        body.kind === 'opening' && body.inputs.opening_sha256 === openingSha256
    )
    .pop();
  if (!opening) {
    return null;
  }
  const switchedAt = opening.at_ms;
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET switch_at = :switchedAt, opening_uri = :openingUri, history_uri = :historyUri
      WHERE id = :id AND opening_sha256 = :sha AND suspended_at IS NULL`,
    {
      switchedAt,
      openingUri: opening.inputs.opening_uri,
      historyUri: opening.inputs.history_uri,
      id: OPENING_STATE_ID,
      sha: openingSha256
    }
  );
  subscriptionsIdentitySwitch.invalidate();
  return switchedAt;
}

/**
 * The rebuild check's rebuilder for the identity subscription tables: the
 * production rebuild (rebuildIdentityTables) from empty tables, reading
 * - the journal from the record log, walked from the records wave's head
 *   drops (the drops table, as the records service posted them) and its
 *   segment files from the files source, and
 * - the opening and history files the journal names from the files source;
 * then the switch the journal records, put back at its time. The
 * production CLI's `rebuild --go-live` switches again at a new time with a
 * new opening entry instead; the check restores the recorded one so the
 * state row compares equal and the step writes nothing to the record log.
 * It fails when the journal holds no write, so a seed whose entries never
 * reached a closed segment cannot pass as an empty rebuild.
 */
export async function rebuildSubscriptionsInCheck(
  ctx: CheckStepContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const files = ctx.sources.files;
  if (!files) {
    throw new Error(
      'The subscriptions rebuild reads files: the run has no files source'
    );
  }
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !profileId || !wallet || providers.length === 0) {
    throw new Error(
      'The subscriptions rebuild reads the records wave: SIGNED_RECORDS_WAVE_ID, SIGNED_RECORDS_SERVICE_PROFILE_ID, SIGNED_RECORDS_SERVICE_WALLET and SIGNED_RECORDS_PROVIDER_KEYS are needed'
    );
  }
  const reader = new RecordLogReader({
    wave: new LocalRecordsWaveReader({ waveId, profileId, wallet }),
    fetcher: segmentFetcher(files),
    serviceWallets: [wallet],
    providers
  });
  const source = recordsWaveJournal(reader);
  const { bodies } = await readJournal(source);
  if (bodies.length === 0) {
    throw new Error(
      "The journal holds no write: the seed's entries never reached a closed segment"
    );
  }
  const result = await rebuildIdentityTables({
    source,
    fetch: arweaveFromFiles(files)
  });
  if (result.missing) {
    throw new Error(`The rebuilt journal is incomplete: ${result.missing}`);
  }
  const switchedAt =
    result.suspendedAtN === null
      ? await restoreRecordedSwitch(bodies, result.openingSha256)
      : null;
  logger.info(
    `[SUBSCRIPTIONS_REBUILD_CHECK] [opening ${result.openingSha256}] [writes ${result.entries}] [checkpoints ${result.checkpoints}] [switch ${switchedAt ?? 'none'}]`
  );
}

/**
 * The rollback copy's final rows, list uploads and redemptions, copied back
 * from the rebuilt identity tables (legacy-copy.ts). Runs after
 * subs.identity.
 */
export async function rebuildLegacyHistoryInCheck(): Promise<void> {
  const { finals, uploads, redemptions, leftOut } = await copyLegacyHistory();
  logger.info(
    `[SUBSCRIPTIONS_LEGACY_HISTORY] [finals ${finals}] [uploads ${uploads}] [redemptions ${redemptions}] [left out ${leftOut}]`
  );
}

/**
 * The rollback copy's balances, modes and choices, under each identity's
 * consolidation key as the dual write uses it (legacy-copy.ts). Runs after
 * subs.identity, and reads the identity mirror for the keys.
 */
export async function rebuildLegacyStateInCheck(): Promise<void> {
  const { balances, modes, choices, leftOut } = await copyLegacyState();
  logger.info(
    `[SUBSCRIPTIONS_LEGACY_STATE] [balances ${balances}] [modes ${modes}] [choices ${choices}] [left out ${leftOut}]`
  );
}
