import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import { saveDistributionPhotos } from '@/api/distribution-photos/api.distribution_photos.db';
import {
  insertAutomaticAirdropsForPhase,
  populateDistribution,
  populateDistributionNormalized
} from '@/api/distributions/api.distributions.service';
import { upsertMintingClaimActionAndGetResponse } from '@/api/minting-claims/minting-claim-actions.api.service';
import {
  persistAllowlist,
  persistCollectionBurn
} from '@/api/nextgen/nextgen.routes';
import { splitAllowlistResults } from '@/api/subscriptions/api.subscriptions.allowlist';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  PROFILES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE
} from '@/constants';
import {
  fetchMaxTransactionByBlockNumber,
  persistRememesUpload,
  persistRoyaltiesUpload
} from '@/db';
import { DropType } from '@/entities/IDrop';
import { addRememe } from '@/db-api';
import { writeClosedMemesMintStats } from '@/memes-mint-stats/memes-mint-stats.rebuild';
import { mintingClaimsDb } from '@/minting-claims/minting-claims.db';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogSegmenter } from '@/signed-records/record-log/record-log.service';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { sqlExecutor } from '@/sql-executor';
import { updateDistributionMints } from '@/transactionsProcessingLoop/distribution';
import { MintContentPort, runMintGenesis } from './mint-log-genesis';
import { distributionCursorBlock } from './mint-log-inputs';
import { mintCard } from './mint-log-parts';
import { logPublicationReceipt } from './mint-log-receipts';
import { getMintLogPorts } from './mint-log-ports';
import {
  PROBE_MAIN_STAGE_WAVE,
  PROBE_PHASE_WALLETS
} from './mint-log-rebuild.ids';
import { chainHeadTime } from './mint-log-rebuild.chain-clock';
import { seedCollaboration } from './mint-log-rebuild.seed-collab';
import {
  assertLatestDropTimes,
  insertDrop,
  insertWave,
  SEEDED_AT
} from './mint-log-rebuild.seed-rows';
import { mintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import {
  MintCardRef,
  MintLogKind,
  NEXTGEN_CARD_CONTRACT,
  REMEMES_CARD_CONTRACT
} from './mint-log.types';

/**
 * The rebuild check's seed for the mint area: the probe fixture
 * (`src/rebuild/manifests/probe-fixture.ts`: wallets 0x..01 and 0x..02, meme
 * cards 1 and 2), reached the way production reaches it:
 * 1. before the log: card 1, a rememe on contract 0x..04 and a royalties
 *    upload, written by the minting writers with no log around them;
 * 2. the genesis, as `mint-log:genesis --live` writes it: a file per card in
 *    the run's seed files and the genesis entries in the record log;
 * 3. logged writes, each wrapped by the mint log as a live write is: card
 *    1's photos and a second claim action, card 2 whole, a rememe on
 *    0x..03, an upload of each kind, NextGen collection 1's phase and
 *    collection 2's burn phase and burn registration, and a Main Stage
 *    artwork's collaboration invitation and its acceptance
 *    (mint-log-rebuild.seed-collab.ts);
 * 4. the record log's queue closed into a segment, as the record log loop
 *    closes it: the file in the run's seed files, its head drop in the
 *    records wave, where the mint rebuild reads the entries back;
 * 5. what the log leaves to other writers: mint stats (the NFT loop's
 *    writer, for every mint in the NFT index that has closed on the chain's
 *    clock) and the minted counts (the transactions loop's distribution
 *    pass, which also sets its cursor).
 * The writes are logged only while FEATURE_MINT_LOG_SHADOW or
 * FEATURE_MINT_LOG_PRIMARY is on.
 *
 * It needs the TypeORM data source started (the upload, mint stats and
 * transactions loop writers use it), as the rebuild check's step runner does.
 *
 * The seed's own values are fixed. The rows' created_at and updated_at come
 * from the clock when it runs; the genesis files and the log carry them, so a
 * rebuild repeats them and both probe passes match.
 */

const W1 = '0x0000000000000000000000000000000000000001';
const W2 = '0x0000000000000000000000000000000000000002';
const CONTRACT = MEMES_CONTRACT.toLowerCase();
const REMEME_CONTRACT = '0x0000000000000000000000000000000000000003';
/** The records service's handle and wave description drop, as the personal seed writes them. */
const RECORDS_SERVICE_HANDLE = 'rebuild-records';
const RECORDS_WAVE_DESCRIPTION_DROP = '00000000-0000-4000-8000-0000000000a2';
/** The rememe written before the log, so it reaches the rebuild through the genesis. */
const EARLY_REMEME_CONTRACT = '0x0000000000000000000000000000000000000004';
const NEXTGEN_COLLECTION = 1;
/** A NextGen collection whose phase takes burns of another collection's tokens. */
const NEXTGEN_BURN_COLLECTION = 2;
const NEXTGEN_BURN_ROOT = `0x${'2'.repeat(64)}`;

/** Runs a minting writer, logged or not. */
type SeedWriter = <T>(
  kind: MintLogKind,
  card: MintCardRef,
  run: () => Promise<T>,
  inputs?: MintWriteSpec<T>['inputs']
) => Promise<T>;

/** A write before the log started: the writer alone. */
const unlogged: SeedWriter = (_kind, _card, run) => run();

function seedWrite<T>(
  kind: MintLogKind,
  card: MintCardRef,
  run: () => Promise<T>,
  inputs?: MintWriteSpec<T>['inputs']
): Promise<T> {
  return mintLogRecorder.write(
    {
      kind,
      card,
      actor: { type: 'service', wallet: null, authority: 'rebuild probe seed' },
      intent: {
        route: 'seed rebuild:probes',
        params: { card: `${card.contract}#${card.key ?? card.card_id}` },
        body: null
      },
      inputs
    },
    run
  );
}

async function seedCard(cardId: number, write: SeedWriter): Promise<void> {
  const card = mintCard(CONTRACT, cardId);
  await write('dist.airdrops', card, () =>
    insertAutomaticAirdropsForPhase(
      CONTRACT,
      cardId,
      DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      [{ address: W1, count: 1 }]
    )
  );
  await write('dist.airdrops', card, () =>
    insertAutomaticAirdropsForPhase(
      CONTRACT,
      cardId,
      DISTRIBUTION_PHASE_AIRDROP_TEAM,
      [{ address: W2, count: 1 }]
    )
  );
  await write('dist.phase', card, async () => {
    const split = await splitAllowlistResults(CONTRACT, cardId, 'Phase 1', [
      {
        id: `probe-${cardId}-1`,
        wallet: PROBE_PHASE_WALLETS[0],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        // Different spots per card: two cards with the same allowlist would
        // have the same merkle root, and a root's proofs are stored once.
        amount: cardId
      },
      {
        id: `probe-${cardId}-2`,
        wallet: PROBE_PHASE_WALLETS[1],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 3
      }
    ]);
    await populateDistribution(CONTRACT, cardId, 'Phase 1', split);
  });
  await write(
    'dist.normalize',
    card,
    () => populateDistributionNormalized(CONTRACT, cardId),
    async (connection) => ({
      distribution_cursor_block: await distributionCursorBlock(connection)
    })
  );
  await write('dist.photos', card, () =>
    saveDistributionPhotos(CONTRACT, cardId, [
      `https://media.example/rebuild-probe/card-${cardId}.jpg`
    ])
  );
  await write('claim.built', card, () =>
    sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      mintingClaimsDb.createMintingClaim(
        [
          {
            drop_id: `rebuild-probe-drop-${cardId}`,
            contract: CONTRACT,
            claim_id: cardId,
            image_location: null,
            animation_location: null,
            metadata_location: null,
            description: `Probe card ${cardId}`,
            name: `Probe card ${cardId}`,
            image_url: `https://media.example/rebuild-probe/card-${cardId}.png`,
            external_url: null,
            attributes: [{ trait_type: 'Type', value: 'Probe' }],
            image_details: null,
            animation_url: null,
            animation_details: null,
            animation_kind: null
          }
        ],
        { connection }
      )
    )
  );
  await write('claim.action', card, () =>
    upsertMintingClaimActionAndGetResponse(
      CONTRACT,
      cardId,
      { action: 'ARTIST_AIRDROP', completed: true },
      W1,
      {}
    )
  );
}

async function seedRememe(
  contract: string,
  collectionName: string,
  write: SeedWriter
): Promise<void> {
  await write('rememe.add', mintCard(REMEMES_CARD_CONTRACT, 0, contract), () =>
    addRememe(W1, {
      contract: {
        address: contract,
        contractDeployer: W2,
        openSeaMetadata: { collectionName },
        tokenType: 'ERC721'
      },
      nfts: [
        {
          tokenId: '1',
          tokenType: 'ERC721',
          tokenUri: `ipfs://rebuild-probe/rememe/${contract}/1`,
          image: {
            originalUrl: `ipfs://rebuild-probe/rememe/${contract}/1.png`
          },
          raw: {
            metadata: {
              name: `${collectionName} 1`,
              image: `ipfs://rebuild-probe/rememe/${contract}/1.png`
            }
          }
        }
      ],
      references: [1]
    })
  );
}

async function seedUploads(): Promise<void> {
  await logPublicationReceipt(
    REMEMES_UPLOADS,
    'rememes',
    { url: 'https://arweave.net/rebuild-probe-rememes' },
    () => persistRememesUpload('https://arweave.net/rebuild-probe-rememes')
  );
  await logPublicationReceipt(
    ROYALTIES_UPLOADS_TABLE,
    'royalties',
    { date: '2026-01-03', url: 'https://arweave.net/rebuild-probe-royalties' },
    () =>
      persistRoyaltiesUpload(
        new Date('2026-01-03T00:00:00Z'),
        'https://arweave.net/rebuild-probe-royalties'
      )
  );
}

async function seedNextgen(): Promise<void> {
  const leaf = (n: number) => n.toString(16).padStart(64, '0');
  await seedWrite(
    'nextgen.allowlist',
    mintCard(NEXTGEN_CARD_CONTRACT, NEXTGEN_COLLECTION),
    () =>
      persistAllowlist({
        collection_id: NEXTGEN_COLLECTION,
        added_by: W1,
        al_type: 'allowlist',
        phase: 'Phase 1',
        start_time: 1767225600,
        end_time: 1767830400,
        mint_price: 0.05,
        merkle: {
          merkle_root: `0x${'1'.repeat(64)}`,
          // As merkletreejs serializes its leaves.
          merkle_tree: {
            leaves: [1, 2].map((n) => ({
              type: 'Buffer',
              data: Array.from(Buffer.from(leaf(n), 'hex'))
            }))
          },
          allowlist: [W1, W2].map((address, index) => ({
            address,
            spots: index + 1,
            info: `probe-${index + 1}`,
            keccak: `0x${leaf(index + 1)}`
          }))
        }
      })
  );
  const burnCard = mintCard(NEXTGEN_CARD_CONTRACT, NEXTGEN_BURN_COLLECTION);
  await seedWrite('nextgen.allowlist', burnCard, () =>
    persistAllowlist({
      collection_id: NEXTGEN_BURN_COLLECTION,
      added_by: W1,
      al_type: 'external_burn',
      phase: 'Burn phase',
      start_time: 1767225600,
      end_time: 1767830400,
      mint_price: 0,
      merkle: {
        merkle_root: NEXTGEN_BURN_ROOT,
        merkle_tree: {
          leaves: [11, 12].map((n) => ({
            type: 'Buffer',
            data: Array.from(Buffer.from(leaf(n), 'hex'))
          }))
        },
        allowlist: [1, 2].map((tokenId) => ({
          token_id: tokenId,
          info: `probe-burn-${tokenId}`,
          keccak: `0x${leaf(10 + tokenId)}`
        }))
      }
    })
  );
  await seedWrite('nextgen.burn', burnCard, () =>
    persistCollectionBurn({
      collection_id: NEXTGEN_BURN_COLLECTION,
      burn_collection: '0x0000000000000000000000000000000000000005',
      burn_collection_id: 1,
      min_token_index: 0,
      max_token_index: 99,
      burn_address: '0x0000000000000000000000000000000000000006',
      status: true
    })
  );
}

/** Card 1's logged writes after the genesis: new photos, a second claim action. */
async function seedCardChanges(cardId: number): Promise<void> {
  const card = mintCard(CONTRACT, cardId);
  await seedWrite('dist.photos', card, () =>
    saveDistributionPhotos(CONTRACT, cardId, [
      `https://media.example/rebuild-probe/card-${cardId}.jpg`,
      `https://media.example/rebuild-probe/card-${cardId}-detail.jpg`
    ])
  );
  await seedWrite('claim.action', card, () =>
    upsertMintingClaimActionAndGetResponse(
      CONTRACT,
      cardId,
      { action: 'TEAM_AIRDROP', completed: true },
      W2,
      {}
    )
  );
}

/** Writes a file into the run's seed files and lists it in files.json. */
function seedFile(dir: string, bytes: Buffer): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `f${sha256}`;
  fs.writeFileSync(path.join(dir, id), bytes);
  const index = path.join(dir, 'files.json');
  const listed: Record<string, string> = fs.existsSync(index)
    ? JSON.parse(fs.readFileSync(index, 'utf8'))
    : {};
  listed[id] = sha256;
  fs.writeFileSync(
    index,
    `${JSON.stringify(listed, null, 2)}
`
  );
  return id;
}

/** Genesis files in the run's seed files. */
function seedFilesContent(dir: string): MintContentPort {
  return {
    put: async (_name, bytes) => seedFile(dir, bytes),
    get: async (cid) => fs.readFileSync(path.join(dir, cid))
  };
}

/**
 * The records service of a rebuild run, written as the personal seed writes
 * it when it is missing: its identity and profile, the records wave and the
 * wave's description drop. Personal and publish share this fixture by value,
 * so any of their seeds may run first.
 */
async function insertRecordsService(
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
    { wallet, profileId, handle: RECORDS_SERVICE_HANDLE }
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
      handle: RECORDS_SERVICE_HANDLE,
      wallet,
      createdAt: new Date(SEEDED_AT)
    }
  );
  await insertWave({
    id: waveId,
    createdBy: profileId,
    descriptionDropId: RECORDS_WAVE_DESCRIPTION_DROP,
    creatorFollows: false
  });
}

/**
 * The record log's newest entry when the seed starts. Entries still open at
 * or before it were left by another seed; entries after it are this run's.
 */
export async function recordLogStart(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ last: number | string | null }>(
    `select max(id) as last from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}`
  );
  return Number(row?.last ?? 0);
}

/**
 * Closes the entries this seed's run left open into a segment, as the record
 * log loop does: the file goes into the run's seed files and its head drop
 * into the records wave, posted as the records service with the author's
 * follow that posting a drop writes. All of the run's entries are closed,
 * not only `mint` ones: once the subscriptions' switch is on, the phase
 * split also journals a `subs` entry. Entries open since before the run
 * belong to the seed that wrote them, and stop this one rather than go into
 * its segment.
 */
export async function closeRecordLog(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  startId: number
): Promise<void> {
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !profileId || !wallet || providers.length === 0) {
    throw new Error(
      'The mint seed closes the record log: the SIGNED_RECORDS_* flags are needed'
    );
  }
  const leftovers = await sqlExecutor.execute<{ lane: string }>(
    `select distinct lane from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
     where segment_seq is null and id <= :startId`,
    { startId }
  );
  if (leftovers.length) {
    throw new Error(
      `The record log holds open entries of ${leftovers.map((row) => row.lane).join(', ')} from before the mint seed: the seed that wrote them closes them`
    );
  }
  const [open] = await sqlExecutor.execute<{ entries: number | string }>(
    `select count(*) as entries from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
     where segment_seq is null`
  );
  if (!Number(open?.entries ?? 0)) return;
  await insertRecordsService(waveId, profileId, wallet);
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
        await insertDrop({
          id,
          waveId,
          authorId: profileId,
          createdAt: Date.now(),
          dropType: DropType.CHAT,
          content: text
        });
        return id;
      }
    },
    wave: new LocalRecordsWaveReader({ waveId, profileId, wallet }),
    serviceWallets: [wallet]
  });
  const heads = await segmenter.closeSegments({});
  if (!heads.length) {
    throw new Error('The mint seed closed no segment of the record log');
  }
  // Posting a head logs its failure and goes on, as the loop does; the seed
  // stops instead, so a head drop missing or without its metrics shows here.
  const unposted = await recordLogDb.findSegmentsWithoutHead({});
  if (unposted.length) {
    throw new Error(
      `Record log segments without a head drop after the mint seed posted them: ${unposted
        .map((segment) => `${segment.chain} ${segment.seq}`)
        .join(', ')}`
    );
  }
}

/** What the seed step receives from the rebuild check's runner. */
interface SeedContext {
  readonly seedFilesDir: string | null;
  readonly sources: { readonly ethereum: string | null };
  readonly mark?: { readonly ethBlock: number | null };
}

/**
 * The seed step: before the log, the genesis, the logged writes, the
 * record log's segment, then mint stats and the minted counts (see the
 * comment at the top).
 */
export async function seedMintProbes(
  ctx: SeedContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const dir = ctx.seedFilesDir;
  if (!dir) {
    throw new Error(
      'The mint seed writes genesis files: the run has no files source'
    );
  }
  const log = getMintLogPorts().log;
  if (!log) {
    throw new Error('No record log is bound: the genesis appends to it');
  }
  const startId = await recordLogStart();

  await seedCard(1, unlogged);
  await seedRememe(EARLY_REMEME_CONTRACT, 'Early probe rememes', unlogged);
  await persistRoyaltiesUpload(
    new Date('2026-01-02T00:00:00Z'),
    'https://arweave.net/rebuild-probe-royalties-early'
  );

  await runMintGenesis({ content: seedFilesContent(dir), log });

  await seedCardChanges(1);
  await seedCard(2, seedWrite);
  await seedRememe(REMEME_CONTRACT, 'Probe rememes', seedWrite);
  await seedUploads();
  await seedNextgen();
  await seedCollaboration();

  await closeRecordLog(dir, env, startId);
  await assertLatestDropTimes(
    [PROBE_MAIN_STAGE_WAVE, env.SIGNED_RECORDS_WAVE_ID].filter(
      (id): id is string => !!id
    )
  );

  // Mints close on the chain's clock (see mint-log-rebuild.chain-clock.ts).
  if (ctx.sources.ethereum) {
    await writeClosedMemesMintStats(
      await chainHeadTime(ctx.sources.ethereum, ctx.mark?.ethBlock ?? null)
    );
  }
  // The loop needs a transaction to count up to; without the holdings
  // seed's there are no mints to count.
  if (await fetchMaxTransactionByBlockNumber()) {
    await updateDistributionMints();
  }
}
