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
import { persistAllowlist } from '@/api/nextgen/nextgen.routes';
import { splitAllowlistResults } from '@/api/subscriptions/api.subscriptions.allowlist';
import {
  MEMES_CONTRACT,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE
} from '@/constants';
import { persistRememesUpload, persistRoyaltiesUpload } from '@/db';
import { addRememe } from '@/db-api';
import { insertMemesMintStatsIfMissing } from '@/memes-mint-stats/memes-mint-stats';
import { mintingClaimsDb } from '@/minting-claims/minting-claims.db';
import { sqlExecutor } from '@/sql-executor';
import { distributionCursorBlock } from './mint-log-inputs';
import { mintCard } from './mint-log-parts';
import { logPublicationReceipt } from './mint-log-receipts';
import { mintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import {
  MintCardRef,
  MintLogKind,
  NEXTGEN_CARD_CONTRACT,
  REMEMES_CARD_CONTRACT
} from './mint-log.types';

/**
 * The rebuild check's seed for the mint probes. It writes the probe fixture
 * (`src/rebuild/manifests/probe-fixture.ts`: wallets 0x..01 and 0x..02, meme
 * cards 1 and 2) through the minting writers, each wrapped by the mint log as
 * a live write is, so every row has its entry in the record log. Fixed
 * values only: nothing depends on the clock, so both probe passes match.
 */

const W1 = '0x0000000000000000000000000000000000000001';
const W2 = '0x0000000000000000000000000000000000000002';
const CARDS = [1, 2];
const CONTRACT = MEMES_CONTRACT.toLowerCase();
const REMEME_CONTRACT = '0x0000000000000000000000000000000000000003';
const NEXTGEN_COLLECTION = 1;
/** Mint dates inside the fixture's window (1 to 8 Jan 2026). */
const MINT_DATES = [
  new Date('2026-01-02T00:00:00Z'),
  new Date('2026-01-05T00:00:00Z')
];

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

async function seedCard(cardId: number): Promise<void> {
  const card = mintCard(CONTRACT, cardId);
  await seedWrite('dist.airdrops', card, () =>
    insertAutomaticAirdropsForPhase(
      CONTRACT,
      cardId,
      DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      [{ address: W1, count: 1 }]
    )
  );
  await seedWrite('dist.airdrops', card, () =>
    insertAutomaticAirdropsForPhase(
      CONTRACT,
      cardId,
      DISTRIBUTION_PHASE_AIRDROP_TEAM,
      [{ address: W2, count: 1 }]
    )
  );
  await seedWrite('dist.phase', card, async () => {
    const split = await splitAllowlistResults(CONTRACT, cardId, 'Phase 1', [
      {
        id: `probe-${cardId}-1`,
        wallet: W1,
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        // Different spots per card: two cards with the same allowlist would
        // have the same merkle root, and a root's proofs are stored once.
        amount: cardId
      },
      {
        id: `probe-${cardId}-2`,
        wallet: W2,
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 3
      }
    ]);
    await populateDistribution(CONTRACT, cardId, 'Phase 1', split);
  });
  await seedWrite(
    'dist.normalize',
    card,
    () => populateDistributionNormalized(CONTRACT, cardId),
    async (connection) => ({
      distribution_cursor_block: await distributionCursorBlock(connection)
    })
  );
  await seedWrite('dist.photos', card, () =>
    saveDistributionPhotos(CONTRACT, cardId, [
      `https://media.example/rebuild-probe/card-${cardId}.jpg`
    ])
  );
  await seedWrite('claim.built', card, () =>
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
  await seedWrite('claim.action', card, () =>
    upsertMintingClaimActionAndGetResponse(
      CONTRACT,
      cardId,
      { action: 'ARTIST_AIRDROP', completed: true },
      W1,
      {}
    )
  );
}

async function seedRememe(): Promise<void> {
  await seedWrite(
    'rememe.add',
    mintCard(REMEMES_CARD_CONTRACT, 0, REMEME_CONTRACT),
    () =>
      addRememe(W1, {
        contract: {
          address: REMEME_CONTRACT,
          contractDeployer: W2,
          openSeaMetadata: { collectionName: 'Probe rememes' },
          tokenType: 'ERC721'
        },
        nfts: [
          {
            tokenId: '1',
            tokenType: 'ERC721',
            tokenUri: 'ipfs://rebuild-probe/rememe/1',
            image: { originalUrl: 'ipfs://rebuild-probe/rememe/1.png' },
            raw: {
              metadata: {
                name: 'Probe rememe 1',
                image: 'ipfs://rebuild-probe/rememe/1.png'
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
}

/**
 * The seed step: cards 1 and 2 (distribution, airdrops, a merkle root with
 * both wallets' proofs, normalized rows, a photo, a claim and its action,
 * mint stats), one rememe, one upload of each kind and NextGen collection 1's
 * phase. Mint stats come from the NFT loop's writer, which the mint log does
 * not cover. The step context is not needed.
 */
export async function seedMintProbes(): Promise<void> {
  for (const cardId of CARDS) {
    await seedCard(cardId);
  }
  for (let index = 0; index < CARDS.length; index++) {
    await insertMemesMintStatsIfMissing(CARDS[index], MINT_DATES[index]);
  }
  await seedRememe();
  await seedUploads();
  await seedNextgen();
}
