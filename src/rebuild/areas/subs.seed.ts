import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ADDRESS_CONSOLIDATION_KEY,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  NFTS_TABLE,
  MEMES_CONTRACT,
  PROFILES_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_CONSOLIDATION_KEYS } from '@/rebuild/manifests/probe-fixture';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogSegmenter } from '@/signed-records/record-log/record-log.service';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { sqlExecutor } from '@/sql-executor';
import { updateSubscribeAllEditions } from '@/api/subscriptions/api.subscriptions.db';
import { goLive } from '@/subscriptions-identity/opening/go-live';
import type { FileUploader } from '@/subscriptions-identity/opening/published-chain';
import {
  JOURNAL_LANE,
  JOURNAL_SHADOW_LANE,
  journalCheckpoint
} from '@/subscriptions-identity/timeline/journal';
import { runIdentityTopUpWriters } from '@/subscriptions-identity/writers/identity-loop-hooks';
import { persistTopUps } from '@/subscriptionsTopUpLoop/db.subscriptions_topup';
import { aWave } from '@/tests/fixtures/wave.fixture';

/**
 * The subscriptions area's seed for the rebuild check. Before the drop it
 * puts the stack where the identity tables are the truth, through the
 * paths production uses:
 * 1. the records service identity and the records wave, only if another
 *    seed has not made them (the same fixture values every area uses);
 * 2. legacy subscriptions for the probe wallets: a top-up each (the top-up
 *    loop's write, which turns automatic mode on for the one that covers a
 *    card) and all editions for the first;
 * 3. the switch: `go-live` cuts, verifies, loads, compares and publishes
 *    the opening files into the run's seed files, and journals its opening
 *    entry;
 * 4. after the switch, a top-up through the top-up loop and the identity
 *    writer, and a checkpoint;
 * 5. the journal into the records wave: a closed segment, its file in the
 *    seed files and its head drop, if every open entry is the journal's;
 *    otherwise the seed that closes the shared log's segments takes them.
 * The rebuild then gets the identity tables back from the opening files
 * and the journal alone.
 */

// Fixed, so a second pass minutes later answers the same.
const SEEDED_AT = 1_767_225_600_000;
const TOP_UP_TEXT = '2026-01-01 00:00:00';

/** Fake top-up transactions of the probe wallets (never on any chain). */
const BEFORE_TOP_UPS = [
  {
    hash: `0x${'5'.repeat(63)}1`,
    wallet: PROBE_CONSOLIDATION_KEYS[0],
    amount: 0.25
  },
  {
    hash: `0x${'5'.repeat(63)}2`,
    wallet: PROBE_CONSOLIDATION_KEYS[1],
    amount: 0.05
  }
];
const AFTER_TOP_UP = {
  hash: `0x${'5'.repeat(63)}3`,
  wallet: PROBE_CONSOLIDATION_KEYS[1],
  amount: 0.1
};

async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const known = new Set(
    (
      await sqlExecutor.execute<{ name: string }>(
        `select column_name as name from information_schema.columns
         where table_schema = database() and table_name = :table`,
        { table }
      )
    ).map((column) => column.name)
  );
  const columns = Object.keys(row).filter((column) => known.has(column));
  const params = Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      return [
        column,
        value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value
      ];
    })
  );
  await sqlExecutor.execute(
    `insert ignore into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
     values (${columns.map((c) => `:${c}`).join(', ')})`,
    params
  );
}

/** The records service's identity, profile and wave, if they are missing. */
async function ensureRecordsService(
  waveId: string,
  profileId: string,
  wallet: string
): Promise<void> {
  await sqlExecutor.execute(
    `insert ignore into ${IDENTITIES_TABLE}
       (consolidation_key, profile_id, primary_address, handle,
        normalised_handle, tdh, rep, cic, level_raw, classification,
        xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
     values (:wallet, :profileId, :wallet, :handle, :handle,
        0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
    { wallet, profileId, handle: 'rebuild-records' }
  );
  await sqlExecutor.execute(
    `insert ignore into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
     values (:wallet, :wallet)`,
    { wallet }
  );
  await sqlExecutor.execute(
    `insert ignore into ${PROFILES_TABLE}
       (external_id, handle, normalised_handle, primary_wallet, created_at,
        created_by_wallet, classification)
     values (:profileId, :handle, :handle, :wallet, :createdAt, :wallet,
        'PSEUDONYM')`,
    {
      profileId,
      handle: 'rebuild-records',
      wallet,
      createdAt: new Date(SEEDED_AT)
    }
  );
  const { serial_no: _serial, ...wave } = aWave(
    { is_direct_message: false, created_by: profileId, created_at: SEEDED_AT },
    { id: waveId, name: waveId }
  );
  await insertRow(WAVES_TABLE, wave);
}

/** A file in the run's seed files, listed in its files.json; returns its id. */
function seedFile(dir: string, bytes: Buffer): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `s${sha256}`;
  fs.writeFileSync(path.join(dir, id), bytes);
  const index = path.join(dir, 'files.json');
  const listed: Record<string, string> = fs.existsSync(index)
    ? JSON.parse(fs.readFileSync(index, 'utf8'))
    : {};
  listed[id] = sha256;
  fs.writeFileSync(index, `${JSON.stringify(listed, null, 2)}\n`);
  return id;
}

/** go-live's uploader: the seed files, under the URL Arweave would give. */
function seedFilesUploader(dir: string): FileUploader {
  return {
    uploadFile: async (buffer) => ({
      url: `https://arweave.net/${seedFile(dir, buffer)}`
    })
  };
}

/** Top-ups as the top-up loop writes them, one call each. */
async function topUp(
  hash: string,
  wallet: string,
  amount: number,
  block: number
): Promise<void> {
  await persistTopUps([
    {
      hash,
      block,
      transaction_date: new Date(`${TOP_UP_TEXT}Z`),
      from_wallet: wallet,
      amount
    }
  ]);
}

/** The newest memes card the holdings seed minted (0 when none). */
async function newestMemeCard(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ id: number | null }>(
    `select max(id) as id from ${NFTS_TABLE} where contract = :contract`,
    { contract: MEMES_CONTRACT }
  );
  return Number(row?.id ?? 0);
}

/**
 * The transactions loop's processed block, as its first run sets it (the
 * newest transaction's): the cut refuses a redemption loop that never ran.
 */
async function markRedemptionLoopRun(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ block: number | null }>(
    `select max(block) as block from ${TRANSACTIONS_TABLE}`
  );
  const block = Number(row?.block ?? 0);
  await sqlExecutor.execute(
    `insert into ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      values (now(), :block, 0)`,
    { block }
  );
  return block;
}

/** Closes the log's open segments when every open entry is the journal's. */
async function closeJournalSegments(
  dir: string,
  waveId: string,
  serviceProfileId: string,
  serviceWallet: string,
  providers: ReturnType<typeof loadProviderKeys>
): Promise<boolean> {
  const lanes = await sqlExecutor.execute<{ lane: string }>(
    `select distinct lane from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} where segment_seq is null`
  );
  const others = lanes
    .map((row) => row.lane)
    .filter((lane) => lane !== JOURNAL_LANE && lane !== JOURNAL_SHADOW_LANE);
  if (others.length > 0) {
    return false;
  }
  const segmenter = new RecordLogSegmenter({
    store: recordLogDb,
    providers,
    pinner: {
      pin: async (bytes) => seedFile(dir, bytes),
      fetch: async (cid) => fs.readFileSync(path.join(dir, cid))
    },
    archiver: {
      upload: () => {
        throw new Error('The seed archives nothing');
      }
    },
    poster: {
      post: async (text) => {
        const id = randomUUID();
        await insertRow(DROPS_TABLE, {
          id,
          wave_id: waveId,
          author_id: serviceProfileId,
          created_at: Date.now(),
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: true
        });
        await insertRow(DROPS_PARTS_TABLE, {
          drop_id: id,
          drop_part_id: 1,
          content: text,
          quoted_drop_id: null,
          quoted_drop_part_id: null,
          wave_id: waveId
        });
        return id;
      }
    },
    wave: new LocalRecordsWaveReader({
      waveId,
      profileId: serviceProfileId,
      wallet: serviceWallet
    }),
    serviceWallets: [serviceWallet]
  });
  const heads = await segmenter.closeSegments({});
  if (!heads.length) {
    throw new Error('The subscriptions seed closed no segment');
  }
  return true;
}

export async function seedSubscriptions(
  ctx: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const dir = ctx.seedFilesDir;
  if (!dir) {
    throw new Error(
      'The subscriptions seed writes the opening files: the run has no files source'
    );
  }
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const serviceProfileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const serviceWallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !serviceProfileId || !serviceWallet || !providers.length) {
    throw new Error("The subscriptions seed needs the area's records flags");
  }
  await ensureRecordsService(waveId, serviceProfileId, serviceWallet);

  // Before the switch: today's subscriptions of the probe wallets.
  const block = await markRedemptionLoopRun();
  for (let index = 0; index < BEFORE_TOP_UPS.length; index++) {
    const top = BEFORE_TOP_UPS[index];
    await topUp(top.hash, top.wallet, top.amount, block + index + 1);
  }
  await updateSubscribeAllEditions(PROBE_CONSOLIDATION_KEYS[0], true);

  // The switch, with the opening files in the run's seed files. The
  // record log's closer does not run in a seed, so the posting probe is
  // answered here: the seed closes the segment itself below.
  const result = await goLive({
    signedWritesLive: true,
    acceptReportDiffs: true,
    mintedCard: await newestMemeCard(),
    uploader: seedFilesUploader(dir),
    postingProbe: async () => true,
    settleMs: 0
  });
  if (!result.switched) {
    throw new Error(
      `The subscriptions seed's go-live did not switch: ${result.steps.join('; ')}`
    );
  }

  // After it: a top-up the identity writer journals, and a checkpoint.
  await topUp(
    AFTER_TOP_UP.hash,
    AFTER_TOP_UP.wallet,
    AFTER_TOP_UP.amount,
    block + BEFORE_TOP_UPS.length + 1
  );
  await runIdentityTopUpWriters();
  await journalCheckpoint();

  await closeJournalSegments(
    dir,
    waveId,
    serviceProfileId,
    serviceWallet,
    providers
  );
}
