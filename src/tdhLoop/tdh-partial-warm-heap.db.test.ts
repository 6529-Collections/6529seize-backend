import 'reflect-metadata';
import * as v8 from 'v8';
import * as vm from 'vm';
import {
  connect,
  disconnect,
  fetchTDHForBlock,
  getDataSource,
  persistConsolidatedTDH,
  persistTDH
} from '@/db';
import { releaseHeapAfterReconsolidation } from '@/delegationsLoop/heap-release';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDH,
  TDHBlock,
  TDHEditions,
  TDHMemes
} from '@/entities/ITDH';
import { snapshotRows } from '@/tdhLoop/tdh-row-diff';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import {
  BLOCK,
  consolidatedRows,
  DATE,
  editionRows,
  Group,
  groupsBefore,
  nftRows,
  RUN,
  seasonRows,
  seedWorld,
  wallet,
  walletRows
} from '@/tests/fixtures/partial-tdh-world.fixture';

/**
 * A warm delegationsLoop sandbox runs invocation after invocation in one
 * process. After each partial TDH write and the collection that ends a
 * reconsolidation run, the heap must be back where it was: nothing a write
 * builds (stored-row digests, the wallet TDH snapshot, read streams and their
 * listeners) may outlive the invocation.
 */

const GROUPS = Number(process.env.WARM_HEAP_GROUPS ?? 4000);
const RUNS = 6;
/**
 * Heap noise after settled collections is under a megabyte locally; anything
 * a run kept would add up over the runs.
 */
const TOLERANCE_BYTES = 4 * 1024 * 1024;

const ENTITIES = [
  TDH,
  TDHMemes,
  TDHEditions,
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  ConsolidatedTDHEditions,
  HistoricConsolidatedTDH,
  NftTDH,
  TDHBlock
];

v8.setFlagsFromString('--expose-gc');
const exposedGc = vm.runInNewContext('gc') as () => void;

/** One warm invocation: connect, a partial write of one wallet, disconnect. */
async function invocation(groups: Group[], runAt: number) {
  await connect(ENTITIES);
  const storedTdh = snapshotRows(
    getDataSource().getMetadata(TDH),
    await fetchTDHForBlock(BLOCK)
  );
  await persistTDH(
    BLOCK,
    walletRows(groups, true),
    seasonRows(groups, true).map(
      ({ key, ...row }) => ({ ...row, wallet: key }) as TDHMemes
    ),
    editionRows(groups).map(
      ({ key, ...row }) => ({ ...row, wallet: key }) as TDHEditions
    ),
    [wallet(5)],
    { storedTdh }
  );
  await persistConsolidatedTDH(
    BLOCK,
    consolidatedRows(groups, { shuffleKeys: true, computed: true, runAt }),
    seasonRows(groups).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHMemes
    ),
    editionRows(groups).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHEditions
    ),
    nftRows(groups),
    {
      mode: 'PARTIAL',
      wallets: [wallet(5)],
      consolidationKeysToReplace: [wallet(5)]
    },
    DATE
  );
  await disconnect();
}

describe('partial TDH writes on a warm instance', () => {
  afterEach(() => {
    delete (globalThis as { gc?: () => void }).gc;
  });

  it('leave the heap where it was after each invocation and its collection', async () => {
    await resetTestDatabase();
    await connect(ENTITIES);
    await seedWorld(groupsBefore(GROUPS));
    await disconnect();
    // As NODE_OPTIONS=--expose-gc gives the deployed delegationsLoop.
    (globalThis as { gc?: () => void }).gc = exposedGc;

    const heaps: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
      // Each invocation computes its rows anew, as updateTDH does.
      await invocation(groupsBefore(GROUPS), RUN + run * 60_000);
      releaseHeapAfterReconsolidation();
      // Settle what one collection can leave for the next (weak references,
      // finalizers), so only what is still reachable is measured.
      exposedGc();
      exposedGc();
      heaps.push(process.memoryUsage().heapUsed);
    }

    // The first run warms caches (modules, query parsers); none after grows.
    const [first, ...later] = heaps;
    for (const heap of later) {
      expect(heap - first).toBeLessThan(TOLERANCE_BYTES);
    }
  }, 600_000);
});
