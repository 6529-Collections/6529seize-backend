import {
  buildWavesGatewayWorld,
  startGatewayWorld,
  WavesGatewayWorld,
  WORLD_NETWORK
} from '@/rebuild/world/waves/gateway-world';
import { FakeIndexDb } from '@/tests/fixtures/waves-chain-index.fixture';
import { IndexTableName } from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainIndexSource,
  gatewayChainIndexSource,
  indexChainTo
} from './waves-chain-index.steps';

const TABLES: IndexTableName[] = [
  'groups',
  'waves',
  'roles',
  'polls',
  'waveRep',
  'decisions',
  'entries',
  'votes',
  'results',
  'leaderboards',
  'leaderboardRows'
];

function snapshot(db: FakeIndexDb) {
  return JSON.parse(
    JSON.stringify({
      rows: Object.fromEntries(TABLES.map((t) => [t, db.rows(t)])),
      events: db.events,
      state: db.state
    })
  );
}

/** The world's chain read directly, without HTTP. */
function directSource(world: WavesGatewayWorld): ChainIndexSource {
  const { chain, doneHeight } = world;
  return {
    api: chain,
    finalizedHeight: async () => chain.height,
    headAt: async (height) => {
      const time = (chain as unknown as { timeAt(at: number): number }).timeAt(
        height
      );
      return {
        finalizedHeight: height,
        finalizedTime: time,
        network: WORLD_NETWORK,
        completed: height >= doneHeight,
        doneHeight: height >= doneHeight ? doneHeight : null
      };
    }
  };
}

describe('the waves chain index rebuild step', () => {
  let world: WavesGatewayWorld;
  let gateway: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    world = buildWavesGatewayWorld();
    gateway = await startGatewayWorld(world);
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('reads at the import height, then follows the feed to the mark', async () => {
    const db = new FakeIndexDb();
    const heights = await indexChainTo(
      gatewayChainIndexSource(gateway.url),
      db.asDb(),
      null
    );
    expect(heights).toEqual([world.doneHeight, world.markHeight]);
    expect(db.state).toMatchObject({
      generation: 1,
      fullPhase: null,
      fullFromHeight: world.doneHeight,
      feedNext: world.markHeight + 1,
      readHeight: world.markHeight
    });
    expect(db.rows('waves')).toHaveLength(2);
    expect(db.rows('entries').length).toBeGreaterThan(0);
    const kinds = new Set(db.events.map((e) => e.kind));
    expect(kinds.has('VOTE')).toBe(true);
    expect(kinds.has('RESULT_FINAL')).toBe(true);
    expect(kinds.has('POLL_BALLOT')).toBe(true);
    // No event before the import completed.
    expect(db.events.every((e) => e.height > world.doneHeight)).toBe(true);
  });

  it('gives the same rows, events and state on every run from empty', async () => {
    const first = new FakeIndexDb();
    const second = new FakeIndexDb();
    await indexChainTo(
      gatewayChainIndexSource(gateway.url),
      first.asDb(),
      null
    );
    await indexChainTo(
      gatewayChainIndexSource(gateway.url),
      second.asDb(),
      null
    );
    expect(snapshot(second)).toEqual(snapshot(first));
  });

  it('reads through the gateway routes what the chain answers directly', async () => {
    const overHttp = new FakeIndexDb();
    const direct = new FakeIndexDb();
    await indexChainTo(
      gatewayChainIndexSource(gateway.url),
      overHttp.asDb(),
      null
    );
    await indexChainTo(directSource(world), direct.asDb(), null);
    expect(snapshot(overHttp)).toEqual(snapshot(direct));
  });

  it('stops at the mark height when the run names one', async () => {
    const db = new FakeIndexDb();
    const mark = world.markHeight - 2;
    expect(
      await indexChainTo(gatewayChainIndexSource(gateway.url), db.asDb(), mark)
    ).toEqual([world.doneHeight, mark]);
    expect(db.state.feedNext).toBe(mark + 1);
    expect(db.events.every((e) => e.height <= mark)).toBe(true);
  });

  it('leaves the index empty before the waves import completes', async () => {
    const db = new FakeIndexDb();
    expect(
      await indexChainTo(
        gatewayChainIndexSource(gateway.url),
        db.asDb(),
        world.doneHeight - 1
      )
    ).toEqual([]);
    expect(db.rows('waves')).toEqual([]);
  });

  it('refuses a mark past the finalized height', async () => {
    await expect(
      indexChainTo(
        gatewayChainIndexSource(gateway.url),
        new FakeIndexDb().asDb(),
        world.markHeight + 1
      )
    ).rejects.toThrow(/past the gateway's finalized/);
  });
});
