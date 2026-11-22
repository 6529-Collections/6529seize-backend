// The routers build their auth middleware on import; the endpoints this
// test reads are public, so authentication passes through.
jest.mock('@/api/auth/auth', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) =>
    next();
  return {
    ...jest.requireActual('@/api/auth/auth'),
    needsAuthenticatedUser: pass,
    maybeAuthenticatedUser: pass
  };
});

import 'reflect-metadata';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import distributionPhotosRoutes from '@/api/distribution-photos/api.distribution_photos.routes';
import distributionsRoutes from '@/api/distributions/api.distributions.routes';
import mintingClaimsRoutes from '@/api/minting-claims/api.minting-claims.routes';
import {
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import {
  insertAutomaticAirdropsForPhase,
  populateDistribution,
  populateDistributionNormalized
} from '@/api/distributions/api.distributions.service';
import { saveDistributionPhotos } from '@/api/distribution-photos/api.distribution_photos.db';
import { updateMintingClaim } from '@/api/minting-claims/api.minting-claims.db';
import { upsertMintingClaimActionAndGetResponse } from '@/api/minting-claims/minting-claim-actions.api.service';
import {
  resetAllowlist,
  splitAllowlistResults
} from '@/api/subscriptions/api.subscriptions.allowlist';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  MANIFOLD,
  MEME_CARD_DROP_MAPPINGS_TABLE,
  MEMES_CONTRACT,
  MINT_LOG_HEAD_TABLE,
  MINTING_CLAIM_ACTIONS_TABLE,
  MINTING_CLAIMS_TABLE,
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { mintStateReader } from './mint-log-capture';
import { differingParts } from './mint-log-diff';
import { MintContentPort, runMintGenesis } from './mint-log-genesis';
import { distributionCursorBlock } from './mint-log-inputs';
import { mintCard } from './mint-log-parts';
import type { MintRecordLogEntry, MintRecordLogPort } from './mint-log-ports';
import { MintLogRebuilder } from './mint-log-rebuild';
import { rebuildMintLogFromRecordLog } from './mint-log-rebuild.run';
import { MintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import type { MintLogEntryBody, MintLogKind } from './mint-log.types';

const CONTRACT = MEMES_CONTRACT.toLowerCase();
const CARD_ID = 100;
const CARD = mintCard(CONTRACT, CARD_ID);
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const AT = new Date('2026-11-20T00:00:00Z');

const subscription = (n: number) => ({
  consolidation_key: W(n),
  contract: CONTRACT,
  token_id: CARD_ID,
  subscribed_count: 1,
  airdrop_address: W(n),
  balance: 1,
  subscribed_at: '2026-11-20',
  phase: null,
  phase_subscriptions: -1,
  phase_position: -1,
  redeemed_count: 0,
  created_at: AT,
  updated_at: AT
});

const claim = {
  drop_id: 'drop-100',
  contract: CONTRACT,
  claim_id: CARD_ID,
  image_location: null,
  animation_location: null,
  metadata_location: null,
  media_uploading: false,
  edition_size: 300,
  description: 'A card',
  name: 'Card 100',
  image_url: 'https://example.com/a.png',
  external_url: null,
  attributes: [{ trait_type: 'Type', value: 'Card' }],
  image_details: {
    bytes: 10,
    format: 'PNG',
    sha256: 'aa',
    width: 1,
    height: 1
  },
  animation_url: null,
  animation_details: null
};

/** A paid mint (or another transfer) of the card to a wallet. */
function transfer(args: {
  n: number;
  block: number;
  to: string;
  count: number;
  value: number;
  from?: string;
}) {
  return {
    created_at: AT,
    transaction: `0x${args.n.toString(16).padStart(64, '0')}`,
    block: args.block,
    transaction_date: AT,
    from_address: (args.from ?? MANIFOLD).toLowerCase(),
    to_address: args.to,
    contract: CONTRACT,
    token_id: CARD_ID,
    token_count: args.count,
    value: args.value,
    primary_proceeds: args.value,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0
  };
}

/** The tables a rebuild starts from: empty, apart from rows other modules own. */
async function emptyMintTables(): Promise<void> {
  for (const table of [
    DISTRIBUTION_TABLE,
    DISTRIBUTION_NORMALIZED_TABLE,
    DISTRIBUTION_PHOTO_TABLE,
    MINTING_MERKLE_ROOTS_TABLE,
    MINTING_MERKLE_PROOFS_TABLE,
    MINTING_CLAIMS_TABLE,
    MINTING_CLAIM_ACTIONS_TABLE,
    MEME_CARD_DROP_MAPPINGS_TABLE,
    MINT_LOG_HEAD_TABLE,
    // The loop cursor too: the rebuild must set it, or the loop counts
    // every mint again from block 0.
    TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
  ]) {
    await sqlExecutor.execute(`delete from ${table}`);
  }
  // The subscriptions rebuild restores these rows; the mint log sets their phases.
  await sqlExecutor.execute(
    `update ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
     set phase = null, phase_subscriptions = -1, phase_position = -1`
  );
}

function memoryContent(): MintContentPort {
  const files = new Map<string, Buffer>();
  return {
    put: async (name, bytes) => {
      files.set(`cid-${name}`, bytes);
      return `cid-${name}`;
    },
    get: async (cid) => {
      const bytes = files.get(cid);
      if (!bytes) throw new Error(`No file ${cid}`);
      return bytes;
    }
  };
}

async function capture() {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    mintStateReader.capture(CARD, connection)
  );
}

/**
 * The public endpoints that read the minting tables, answered by the real
 * routers. Minted counts come from the distribution loop, which this test
 * does not run; the minted-count test below checks them.
 */
async function endpointJson(): Promise<Record<string, unknown>> {
  const app = express();
  app.use('/api/distribution_photos', distributionPhotosRoutes);
  app.use('/api/minting-claims', mintingClaimsRoutes);
  app.use('/api', distributionsRoutes);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const answers: Record<string, unknown> = {};
    for (const path of [
      `/distribution_phases/${CONTRACT}/${CARD_ID}`,
      `/distributions?card_id=${CARD_ID}&contract=${CONTRACT}`,
      `/distribution_photos/${CONTRACT}/${CARD_ID}`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/roots`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/airdrops`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/allowlists`
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`);
      const body = JSON.parse(await response.text(), (key, value) =>
        key === 'minted' || key === 'total_count' ? undefined : value
      );
      answers[path] = { status: response.status, body };
    }
    return answers;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function cursor() {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    distributionCursorBlock(connection)
  );
}

async function normalizedCounts() {
  return sqlExecutor.execute<{
    wallet: string;
    minted: number;
    total_count: number;
  }>(
    `select wallet, minted, total_count from ${DISTRIBUTION_NORMALIZED_TABLE}
     where card_id = :card_id order by wallet`,
    { card_id: CARD_ID }
  );
}

const phaseResult = (n: number, amount: number) => ({
  id: `r${n}`,
  wallet: W(n),
  phaseId: 'p',
  allowlistId: 'a',
  phaseComponentId: 'c',
  amount
});

describeWithSeed(
  'mint log on MySQL',
  [
    {
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [subscription(1), subscription(2), subscription(3)]
    },
    { table: MINTING_CLAIMS_TABLE, rows: [claim] },
    {
      table: TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE,
      rows: [{ block: 100, timestamp: 1, created_at: AT }]
    },
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        // Before the cursor block 100: not counted.
        transfer({ n: 1, block: 90, to: W(1), count: 1, value: 0.06529 }),
        // After it: counted.
        transfer({ n: 2, block: 120, to: W(1), count: 2, value: 0.13058 }),
        transfer({ n: 3, block: 121, to: W(4), count: 1, value: 0.06529 }),
        // A free transfer, and one from another address: not mints.
        transfer({ n: 4, block: 130, to: W(1), count: 5, value: 0 }),
        transfer({
          n: 5,
          block: 140,
          to: W(1),
          count: 3,
          value: 0.1,
          from: W(8)
        })
      ]
    }
  ],
  () => {
    const entries: MintLogEntryBody[] = [];
    const log: MintRecordLogPort = {
      append: async (queued: readonly MintRecordLogEntry[]) => {
        for (const entry of queued) {
          if (entry.t === 'entry') {
            entries.push(entry.body as unknown as MintLogEntryBody);
          }
        }
      }
    };
    const recorder = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => true,
        isMintLogPrimaryEnabled: () => false,
        isMintLogReplayCheckEnabled: () => true
      },
      () => ({ records: null, log })
    );

    const write = <T>(kind: MintLogKind, run: () => Promise<T>) => {
      const spec: MintWriteSpec<T> = {
        kind,
        card: CARD,
        actor: { type: 'admin', wallet: W(9), authority: 'test' },
        intent: { route: kind, params: {}, body: null },
        // As the normalize route records it.
        inputs:
          kind === 'dist.normalize'
            ? async (connection) => ({
                distribution_cursor_block:
                  await distributionCursorBlock(connection)
              })
            : undefined
      };
      return recorder.write(spec, run);
    };

    beforeEach(() => {
      entries.length = 0;
    });

    it('logs each real writer exactly, and the log rebuilds the tables', async () => {
      const content = memoryContent();
      await runMintGenesis({ content, log, chains: ['mint'] });
      await write('dist.airdrops', () =>
        insertAutomaticAirdropsForPhase(
          CONTRACT,
          CARD_ID,
          DISTRIBUTION_PHASE_AIRDROP_ARTIST,
          [
            { address: W(5), count: 1 },
            { address: W(6), count: 2 }
          ]
        )
      );
      await write('dist.airdrops', () =>
        insertAutomaticAirdropsForPhase(
          CONTRACT,
          CARD_ID,
          DISTRIBUTION_PHASE_AIRDROP_TEAM,
          [{ address: W(7), count: 3 }]
        )
      );
      await write('dist.phase', async () => {
        const split = await splitAllowlistResults(
          CONTRACT,
          CARD_ID,
          'Phase 1',
          [phaseResult(1, 2), phaseResult(2, 1), phaseResult(4, 3)]
        );
        await populateDistribution(CONTRACT, CARD_ID, 'Phase 1', split);
      });
      // The daily loop re-keys a subscriber whose wallets consolidated, in
      // place: the row keeps its id, which the phase entries are keyed by.
      await sqlExecutor.execute(
        `update ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} set consolidation_key = :key
         where consolidation_key = :old`,
        { key: `${W(1)}-${W(9)}`, old: W(1) }
      );
      await write('dist.normalize', () =>
        populateDistributionNormalized(CONTRACT, CARD_ID)
      );
      await write('dist.photos', () =>
        saveDistributionPhotos(CONTRACT, CARD_ID, [
          'https://example.com/1.jpg',
          'https://example.com/2.jpg'
        ])
      );
      await write('claim.edit', () =>
        updateMintingClaim(CONTRACT, CARD_ID, {
          edition_size: 400,
          attributes: [{ trait_type: 'Type', value: 'Edited' }]
        })
      );
      await write('claim.action', () =>
        upsertMintingClaimActionAndGetResponse(
          CONTRACT,
          CARD_ID,
          { action: 'ARTIST_AIRDROP', completed: true },
          W(9),
          {}
        )
      );
      await write('dist.reset', () => resetAllowlist(CONTRACT, CARD_ID));
      await write('dist.phase', async () => {
        const split = await splitAllowlistResults(
          CONTRACT,
          CARD_ID,
          'Phase 2',
          [phaseResult(1, 1), phaseResult(4, 2)]
        );
        await populateDistribution(CONTRACT, CARD_ID, 'Phase 2', split);
      });

      expect(entries.map((entry) => entry.kind)).toEqual([
        'mint.genesis',
        'dist.airdrops',
        'dist.airdrops',
        'dist.phase',
        'dist.normalize',
        'dist.photos',
        'claim.edit',
        'claim.action',
        'dist.reset',
        'dist.phase'
      ]);
      for (const entry of entries.slice(1)) {
        expect({ kind: entry.kind, checks: entry.checks }).toEqual({
          kind: entry.kind,
          checks: {
            undeclared: [],
            merkle_raw: [],
            replay: 'match',
            replay_mismatches: []
          }
        });
      }
      expect(entries.map((entry) => entry.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9
      ]);
      // Phase 1 put two subscribers in the phase; the reset cleared them.
      expect(entries[3].effects.subscription_phases?.upsert).toHaveLength(2);
      expect(entries[8].effects.subscription_phases?.upsert).toHaveLength(2);

      const live = await capture();
      expect(live.merkle.map((root) => root.row.phase)).toEqual(['Phase 2']);
      const answers = await endpointJson();
      for (const answer of Object.values(answers)) {
        expect(answer).toMatchObject({ status: 200 });
      }

      // Drop the rows, then rebuild from the genesis files and the logged
      // entries as the record log holds them (beside other modules' entries),
      // through the same reducer.
      await emptyMintTables();
      const result = await rebuildMintLogFromRecordLog({
        content,
        source: {
          walk: async function* () {
            yield { entry: { t: 'entry', lane: 'waves', body: {} } as any };
            for (const body of entries) {
              yield {
                entry: {
                  t: 'entry',
                  lane: 'mint',
                  chain: 'public',
                  body: body as unknown as Record<string, unknown>
                }
              };
            }
          }
        }
      });
      expect(result.entries).toBe(10);
      expect(differingParts(await capture(), live)).toEqual([]);
      expect(await cursor()).toBe(140);
      expect(await endpointJson()).toEqual(answers);
      // A second rebuild over the rebuilt rows is refused.
      await expect(
        rebuildMintLogFromRecordLog({
          content,
          source: { walk: async function* () {} }
        })
      ).rejects.toThrow('rebuilds into empty tables');
    });

    it('derives minted counts after the normalize, on top of genesis counts', async () => {
      const content = memoryContent();
      // Before the genesis the card is normalized and has counted 7 mints for
      // one wallet; the genesis pins them with the cursor block (100).
      await insertAutomaticAirdropsForPhase(
        CONTRACT,
        CARD_ID,
        DISTRIBUTION_PHASE_AIRDROP_TEAM,
        [
          { address: W(1), count: 3 },
          { address: W(4), count: 1 }
        ]
      );
      await populateDistributionNormalized(CONTRACT, CARD_ID);
      await sqlExecutor.execute(
        `update ${DISTRIBUTION_NORMALIZED_TABLE} set minted = 7, total_count = 10 where wallet = :wallet`,
        { wallet: W(1) }
      );
      await runMintGenesis({ content, log, chains: ['mint'] });

      await emptyMintTables();
      await new MintLogRebuilder(content).rebuild(entries);
      expect(await cursor()).toBe(140);
      // W1: 7 pinned + 2 minted at block 120; W4: 1 minted at block 121.
      expect(await normalizedCounts()).toEqual([
        { wallet: W(1), minted: 9, total_count: 12 },
        { wallet: W(4), minted: 1, total_count: 2 }
      ]);

      // A normalize after the genesis restarts the counts from its cursor.
      await sqlExecutor.execute(
        `update ${TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE} set block = 120`
      );
      await write('dist.normalize', () =>
        populateDistributionNormalized(CONTRACT, CARD_ID)
      );
      expect(entries[entries.length - 1].inputs).toEqual({
        distribution_cursor_block: 120
      });
      await emptyMintTables();
      await new MintLogRebuilder(content).rebuild(entries);
      expect(await normalizedCounts()).toEqual([
        { wallet: W(1), minted: 0, total_count: 3 },
        { wallet: W(4), minted: 1, total_count: 2 }
      ]);
    });

    it('stops a rebuild whose phase rows are not there', async () => {
      const content = memoryContent();
      await runMintGenesis({ content, log, chains: ['mint'] });
      await write('dist.phase', async () => {
        const split = await splitAllowlistResults(
          CONTRACT,
          CARD_ID,
          'Phase 1',
          [phaseResult(1, 2)]
        );
        await populateDistribution(CONTRACT, CARD_ID, 'Phase 1', split);
      });
      expect(entries[1].effects.subscription_phases?.upsert).toEqual([
        expect.objectContaining({ id: expect.any(Number), phase: 'Phase 1' })
      ]);
      await emptyMintTables();
      // The subscriptions rebuild has not made the rows yet.
      await sqlExecutor.execute(
        `delete from ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
      );
      await expect(
        new MintLogRebuilder(content).rebuild(entries)
      ).rejects.toThrow('matched 0 rows, not 1');
    });
  }
);
