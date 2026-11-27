import { createHash, randomUUID } from 'node:crypto';
import { parseEther, toBeHex } from 'ethers';
import fetch from 'node-fetch';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  NFTS_TABLE,
  MEMES_CONTRACT,
  SUBSCRIPTIONS_ADDRESS,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_CONSOLIDATION_KEYS } from '@/rebuild/manifests/probe-fixture';
import { assertRecordsServiceActor } from '@/rebuild/areas/records-service';
import { WIDE_TOP_UP } from '@/rebuild/areas/subs.wide-identity';
import { profileIdByWallet } from '@/rebuild/run/probe-fixture.steps';
import { encodeSignedRecordsHeader } from '@/signed-records/record-event';
import { familyWave } from '@/signed-records/record-families';
import { RecordKind } from '@/signed-records/record-kinds';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import {
  RecordLogSegmenter,
  RecordLogWriter
} from '@/signed-records/record-log/record-log.service';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import {
  appGrantFixture,
  bindingSource,
  grantSource,
  signedRecord
} from '@/signed-records/record-test-fixtures';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { sqlExecutor } from '@/sql-executor';
import { splitAllowlistResults } from '@/api/subscriptions/api.subscriptions.allowlist';
import { updateSubscribeAllEditions } from '@/api/subscriptions/api.subscriptions.db';
import { mirrorIdentityDirectory } from '@/subscriptions-identity/identity/identity-directory';
import { subscriptionWritePathNow } from '@/subscriptions-identity/identity/identity-switch';
import { goLive } from '@/subscriptions-identity/opening/go-live';
import type { FileUploader } from '@/subscriptions-identity/opening/published-chain';
import {
  recordContentOf,
  SubscriptionChange
} from '@/subscriptions-identity/records/subscription-records';
import {
  legacySubscriptionWrite,
  SubscriptionChangeWriter
} from '@/subscriptions-identity/records/subscription-writes';
import { saveReport } from '@/subscriptions-identity/writers/identity-reports';
import {
  JOURNAL_LANE,
  JOURNAL_SHADOW_LANE,
  journalCheckpoint
} from '@/subscriptions-identity/timeline/journal';
import {
  runIdentityRedemptionWriters,
  runIdentityTopUpWriters,
  runLegacySubscriptionStep
} from '@/subscriptions-identity/writers/identity-loop-hooks';
import { updateSubscriptions } from '@/subscriptionsDaily/subscriptions';
import { discoverTopUps } from '@/subscriptionsTopUpLoop/subscription_topups';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { redeemSubscriptions } from '@/transactionsProcessingLoop/subscriptions';

/**
 * The subscriptions area's seeds for the rebuild check. They put the stack
 * where the identity tables are the truth, through the paths production
 * uses, in the world's order: subscriptions and a card's list first, then
 * the holdings seed mints the cards, then the airdrops are charged.
 *
 * `seedSubscriptions`, before any card is minted:
 * - legacy subscriptions for the probe wallets: a top-up each (the top-up
 *   loop's write, which turns automatic mode on for the one that covers a
 *   card) and all editions for the first;
 * - the transactions loop's processed block, at the chain's head.
 *
 * `seedSubscriptionsSwitch`, which needs the identity mirror:
 * - the records service, the world's actor, read by its wallet, and the
 *   records wave where missing;
 * - the switch: `go-live` cuts, verifies, loads, compares and publishes
 *   the opening files into the run's seed files, and journals its opening
 *   entry;
 * - after it, a top-up through the top-up loop and the identity writer,
 *   and a signed choice through the write route's writer;
 * - the daily build of the next card's list: the identity tables build it
 *   and publish it into the seed files, and the legacy tables get the same
 *   rows;
 * - card 1's subscriptions pulled into an allowlist phase, as an admin does
 *   before the mint;
 * - a checkpoint, and the journal into the records wave: a closed segment,
 *   its file in the seed files and its head drop.
 *
 * `seedSubscriptionRedemptions`, after the holdings seed has minted and
 * indexed the cards: the transactions loop's redemption run, which charges
 * the card's airdrop to its subscriber on both sides, then a checkpoint and
 * the journal's new segment.
 *
 * Every seed closes its own record log entries, so an open entry of
 * another record log lane fails the seed. The rebuild then gets the
 * identity tables back from the opening files and the journal alone.
 */

// Fixed, so a second pass minutes later answers the same.
const SEEDED_AT = 1_767_225_600_000;

/** The probe wallets' top-ups before the switch, in ETH. */
const BEFORE_TOP_UPS: readonly { wallet: string; amount: string }[] = [
  // Covers a card: the top-up loop turns automatic mode on.
  { wallet: PROBE_CONSOLIDATION_KEYS[0], amount: '0.25' },
  { wallet: PROBE_CONSOLIDATION_KEYS[1], amount: '0.05' }
];
/** A top-up after the switch, which the identity writer journals. */
const AFTER_TOP_UP = { wallet: PROBE_CONSOLIDATION_KEYS[1], amount: '0.1' };

/** Blocks past a transfer before the top-up loop reads it (its finality gap). */
const DISCOVERY_CONFIRMATIONS = 6;

/**
 * A top-up as the world makes it: a probe wallet's transfer to the
 * subscriptions address, then the top-up loop's discovery and credit.
 */
export type SeedTopUp = (wallet: string, amountEth: string) => Promise<void>;

export interface SubscriptionsSeedDeps {
  readonly topUp: SeedTopUp;
  /** The chain's newest block. */
  readonly head: () => Promise<number>;
}

async function rpc<T>(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const answer = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result as T;
}

/**
 * Top-ups on the run's anvil: the transfer, blocks past the top-up loop's
 * finality gap, then the loop's own discovery, which credits as it does in
 * production. The wallet is impersonated only for the transfer: a failed
 * balance or transfer call stops the impersonation too, and its own error
 * is the one thrown.
 */
export function anvilTopUps(url: string): SeedTopUp {
  return async (wallet, amountEth) => {
    await rpc(url, 'anvil_impersonateAccount', [wallet]);
    try {
      await rpc(url, 'anvil_setBalance', [wallet, toBeHex(parseEther('10'))]);
      await rpc<string>(url, 'eth_sendTransaction', [
        {
          from: wallet,
          to: SUBSCRIPTIONS_ADDRESS,
          value: toBeHex(parseEther(amountEth))
        }
      ]);
    } catch (error) {
      await rpc(url, 'anvil_stopImpersonatingAccount', [wallet]).catch(
        () => undefined
      );
      throw error;
    }
    await rpc(url, 'anvil_stopImpersonatingAccount', [wallet]);
    await rpc(url, 'anvil_mine', [toBeHex(DISCOVERY_CONFIRMATIONS)]);
    await discoverTopUps();
  };
}

function anvilDeps(ctx: RebuildContext): SubscriptionsSeedDeps {
  const url = ctx.sources.ethereum;
  if (!url) {
    throw new Error(
      'The subscriptions seeds top up on Ethereum: the run has no ethereum source'
    );
  }
  return {
    topUp: anvilTopUps(url),
    head: async () => Number(await rpc<string>(url, 'eth_blockNumber', []))
  };
}

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

/**
 * The records service of the run: the world's actor, read by its wallet,
 * and its records wave, where missing.
 */
async function ensureRecordsService(
  waveId: string,
  profileId: string,
  wallet: string
): Promise<void> {
  await assertRecordsServiceActor(profileId, wallet);
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

/** The newest memes card minted so far: none before the holdings seed. */
async function newestMemeCard(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ id: number | null }>(
    `select max(id) as id from ${NFTS_TABLE} where contract = :contract`,
    { contract: MEMES_CONTRACT }
  );
  return Number(row?.id ?? 0);
}

/**
 * The transactions loop's processed block: the loop has run up to the
 * chain's head, before any card is minted. The cut refuses a redemption
 * loop that never ran, and the loop charges airdrops in later blocks only.
 */
async function markRedemptionLoopRun(block: number): Promise<void> {
  // The loop takes a processed block of 0 as a first run, which charges
  // nothing.
  if (block < 1) {
    throw new Error(
      `The redemption loop's processed block must be past genesis, not ${block}`
    );
  }
  await sqlExecutor.execute(
    `insert into ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      values (now(), :block, 0)`,
    { block }
  );
}

/** The records service and records wave the area's flags name. */
interface RecordsFlags {
  readonly waveId: string;
  readonly serviceProfileId: string;
  readonly serviceWallet: string;
  readonly providers: ReturnType<typeof loadProviderKeys>;
}

function recordsFlags(
  env: Readonly<Record<string, string | undefined>>
): RecordsFlags {
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const serviceProfileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const serviceWallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !serviceProfileId || !serviceWallet || !providers.length) {
    throw new Error("The subscriptions seeds need the area's records flags");
  }
  return { waveId, serviceProfileId, serviceWallet, providers };
}

function seedFilesDir(ctx: RebuildContext): string {
  if (!ctx.seedFilesDir) {
    throw new Error(
      'The subscriptions seeds write the journal and the published files: the run has no files source'
    );
  }
  return ctx.seedFilesDir;
}

/** Runs `fn` with the clock held at `atMs`, as Time.currentMillis reads it. */
async function atClock<T>(atMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => atMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Closes the journal's open entries into a segment. Every seed closes its
 * own entries before it ends, so an open entry of another record log lane
 * means another seed left its own open: the seed refuses rather than close
 * it into the journal's segment.
 */
async function closeJournalSegments(
  dir: string,
  { waveId, serviceProfileId, serviceWallet, providers }: RecordsFlags
): Promise<void> {
  const lanes = await sqlExecutor.execute<{ lane: string }>(
    `select distinct lane from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} where segment_seq is null`
  );
  const others = lanes
    .map((row) => row.lane)
    .filter((lane) => lane !== JOURNAL_LANE && lane !== JOURNAL_SHADOW_LANE);
  if (others.length > 0) {
    throw new Error(
      `Open record log entries of other lanes (${others.join(', ')}): the seed that wrote them must close them first`
    );
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
    // Posts a head drop as the records service, as a drop of the records
    // wave: the drop, its part, the author's follow and the drop metrics.
    // Drop creation also records the activity event and the profile
    // activity log line; no area rebuilds those from the records wave
    // today, so the seed leaves them out. Posting through the drop creation
    // service is the better end state, a follow-up.
    poster: {
      post: async (text) => {
        const id = randomUUID();
        const createdAt = Date.now();
        await insertRow(DROPS_TABLE, {
          id,
          wave_id: waveId,
          author_id: serviceProfileId,
          created_at: createdAt,
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
        // As drop creation does: the author follows their own drop.
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: serviceProfileId,
              target_id: id,
              target_type: ActivityEventTargetType.DROP,
              target_action: ActivityEventAction.DROP_REPLIED,
              wave_id: waveId,
              subscribed_to_all_drops: false
            },
            connection
          )
        );
        // As drop creation does after its commit: the wave's and the
        // author's drop metrics, with the clock at the drop's own time, so
        // the latest drop time is the drop's created_at.
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          atClock(createdAt, () =>
            dropsDb.applyInsertedDropMetricsDelta(
              {
                wave_id: waveId,
                author_id: serviceProfileId,
                drop_type: DropType.CHAT
              },
              { connection }
            )
          )
        );
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
}

/** The card whose list the switch seed builds and whose airdrop is charged. */
const LIST_CARD = 1;

/** The allowlist phase card 1's subscriptions are pulled into. */
const LIST_PHASE = 'Phase 0';

/** The 6529 chain height the seed's signed choice is anchored at. */
const CHOICE_ANCHOR = 1;

/**
 * A signed choice after the switch, through the write route's own writer:
 * the record verified, its event in the record log, the change applied
 * through the record index (which keeps the record's head) to the identity
 * tables and the legacy dual write, and its journal entry. The record is
 * the signed-records fixture device's, under the fixture app grant of a
 * test wallet that is bound to no principal, so it owns its own stream.
 * The rebuild puts its head back from the journal entry.
 */
async function signedChoiceAfterSwitch(): Promise<void> {
  const { grant, proof } = await appGrantFixture();
  const change: SubscriptionChange = { type: 'subs.all-editions', all: true };
  const content = recordContentOf(change);
  const now = Date.now();
  const writer = new SubscriptionChangeWriter({
    path: () => subscriptionWritePathNow(),
    grants: grantSource([grant]),
    bindings: bindingSource([]),
    anchors: {
      getAnchor: async () => ({
        anchor: CHOICE_ANCHOR,
        headHeight: CHOICE_ANCHOR,
        finalizedTime: now,
        maxAnchorLag: 120
      })
    },
    directory: mirrorIdentityDirectory,
    log: new RecordLogWriter(recordLogDb, {
      findGrantProofs: async (ids) => (ids.includes(proof.id) ? [proof] : [])
    }),
    heads: signedRecordHeadsDb,
    legacy: legacySubscriptionWrite,
    saveReport,
    now: () => Date.now()
  });
  const record = signedRecord(grant, {
    kind: RecordKind.RECORD,
    wave: familyWave('ps', grant.wallet),
    refs: content.key === '' ? [content.type] : [content.type, content.key],
    body: content.body,
    seq: 1,
    anchor: CHOICE_ANCHOR,
    claimedTime: now
  });
  await writer.write({
    routeKey: grant.wallet,
    wallet: grant.wallet,
    walletInKey: true,
    signedRecords: encodeSignedRecordsHeader([record]),
    change
  });
}

/**
 * Before the switch and before any card is minted: today's subscriptions
 * of the probe wallets, through the legacy write paths (a top-up each, all
 * editions for the first), the wide identity's top-up, which the key-width
 * guard queues whole, and the transactions loop's processed block.
 */
export async function seedSubscriptions(
  ctx: RebuildContext,
  deps: SubscriptionsSeedDeps = anvilDeps(ctx)
): Promise<void> {
  for (const top of BEFORE_TOP_UPS) {
    await deps.topUp(top.wallet, top.amount);
  }
  // The wide identity is the world's subs-wide actor: read by its wallet,
  // it must be there before its top-up.
  await profileIdByWallet(WIDE_TOP_UP.wallet);
  await deps.topUp(WIDE_TOP_UP.wallet, WIDE_TOP_UP.amount);
  await markRedemptionLoopRun(await deps.head());
  await updateSubscribeAllEditions(PROBE_CONSOLIDATION_KEYS[0], true);
}

/**
 * The switch and the journal: go-live with the opening files in the run's
 * seed files, a top-up after it through the identity writer, a signed
 * choice, the next card's list and its subscription phase, a checkpoint,
 * and the journal's closed segment in the records wave.
 */
export async function seedSubscriptionsSwitch(
  ctx: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: SubscriptionsSeedDeps = anvilDeps(ctx)
): Promise<void> {
  const dir = seedFilesDir(ctx);
  const records = recordsFlags(env);
  // The list is card 1's, which the holdings seed mints after this seed.
  const minted = await newestMemeCard();
  if (minted + 1 !== LIST_CARD) {
    throw new Error(
      `The subscriptions switch seed builds card ${LIST_CARD}'s list before any card is minted, but card ${minted} is minted already: subs.seed and subs.switch must run before holdings.seed`
    );
  }
  await ensureRecordsService(
    records.waveId,
    records.serviceProfileId,
    records.serviceWallet
  );

  // The record log's closer does not run in a seed, so go-live's posting
  // probe is answered here: the seed closes the segment itself below.
  const result = await goLive({
    signedWritesLive: true,
    acceptReportDiffs: true,
    mintedCard: minted,
    uploader: seedFilesUploader(dir),
    postingProbe: async () => true,
    settleMs: 0
  });
  if (!result.switched) {
    throw new Error(
      `The subscriptions switch seed's go-live did not switch: ${result.steps.join('; ')}`
    );
  }

  // After it: a top-up the identity writer journals, and a signed choice.
  await deps.topUp(AFTER_TOP_UP.wallet, AFTER_TOP_UP.amount);
  await runIdentityTopUpWriters();
  await signedChoiceAfterSwitch();

  // The daily build of the next card's list, as the daily loop runs it,
  // with the list published into the seed files.
  await updateSubscriptions({ uploader: seedFilesUploader(dir) });
  const [list] = await sqlExecutor.execute<{ cards: number | string }>(
    `select count(*) as cards from ${SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE}
      where contract = :contract and token_id = :card`,
    { contract: MEMES_CONTRACT, card: LIST_CARD }
  );
  if (!Number(list?.cards)) {
    throw new Error(
      `The subscriptions switch seed's daily build published no list for card ${LIST_CARD}`
    );
  }

  // Before the mint, as an admin does: card 1's subscriptions pulled into
  // an allowlist phase, through the subscriptions module's split, for the
  // first wallet, which is on the list. It writes the phase to the final
  // rows on both sides and journals it.
  await splitAllowlistResults(MEMES_CONTRACT, LIST_CARD, LIST_PHASE, [
    {
      id: 'rebuild-subs-phase-0',
      wallet: PROBE_CONSOLIDATION_KEYS[0],
      phaseId: 'subs-phase-0',
      allowlistId: 'subs-allowlist',
      phaseComponentId: 'subs-component-0',
      amount: 1
    }
  ]);

  await journalCheckpoint();
  await closeJournalSegments(dir, records);
}

/**
 * After the holdings seed has minted and indexed the cards: the
 * transactions loop's redemption run, as its handler runs it (the legacy
 * loop, then the identity writer), which charges the airdrop of the card
 * the switch seed built the list for. Then a checkpoint, and the journal's
 * new entries closed into a segment.
 */
export async function seedSubscriptionRedemptions(
  ctx: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const dir = seedFilesDir(ctx);
  const records = recordsFlags(env);
  await runLegacySubscriptionStep('REDEMPTIONS', () => redeemSubscriptions());
  await runIdentityRedemptionWriters();
  // Card 1's airdrop is charged on both sides, or the seeds ran out of the
  // world's order and the copy-back would prove nothing.
  const [charged] = await sqlExecutor.execute<{
    identity: number | string;
    legacy: number | string;
  }>(
    `select (select count(*) from ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
              where contract = :contract and token_id = :card) as identity,
            (select count(*) from ${SUBSCRIPTIONS_REDEEMED_TABLE}
              where contract = :contract and token_id = :card) as legacy`,
    { contract: MEMES_CONTRACT, card: LIST_CARD }
  );
  if (!Number(charged?.identity) || !Number(charged?.legacy)) {
    // No card at all: the holdings seed mints them, and this seed needs it
    // to have run first (a run that skips it skips this seed too).
    if ((await newestMemeCard()) === 0) {
      throw new Error(
        `The subscriptions redemption seed charged no airdrop: card ${LIST_CARD} isn't minted: holdings.seed mints the cards and must run first`
      );
    }
    throw new Error(
      `The subscriptions redemption seed charged no airdrop of card ${LIST_CARD} (identity ${charged?.identity}, legacy ${charged?.legacy}): subs.switch must build its list before holdings.seed mints the card, and this seed must run after holdings.seed`
    );
  }
  await journalCheckpoint();
  await closeJournalSegments(dir, records);
}
