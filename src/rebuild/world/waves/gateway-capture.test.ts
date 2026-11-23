import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import {
  gatewayChainIndexSource,
  indexChainTo
} from '@/rebuild/steps/waves-chain-index.steps';
import { FakeIndexDb } from '@/tests/fixtures/waves-chain-index.fixture';
import { captureWavesGateway } from './gateway-capture';
import {
  buildWavesGatewayWorld,
  startGatewayWorld,
  WavesGatewayWorld
} from './gateway-world';

function snapshot(db: FakeIndexDb) {
  return JSON.parse(
    JSON.stringify({
      waves: db.rows('waves'),
      entries: db.rows('entries'),
      votes: db.rows('votes'),
      results: db.rows('results'),
      events: db.events,
      state: db.state
    })
  );
}

describe('the waves gateway capture', () => {
  let world: WavesGatewayWorld;
  let node: { url: string; close: () => Promise<void> };
  let dir: string;

  beforeAll(async () => {
    world = buildWavesGatewayWorld();
    node = await startGatewayWorld(world);
  });

  afterAll(async () => {
    await node.close();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-gateway-capture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records what a rebuild reads, at the import height and the mark', async () => {
    let phase1Done = false;
    const result = await captureWavesGateway({
      gateway: node.url,
      dir,
      madeBy: 'a test of the capture',
      pollMs: 10,
      waitForMark: async () => {
        phase1Done = true;
      }
    });
    expect(phase1Done).toBe(true);
    expect(result).toMatchObject({
      doneHeight: world.doneHeight,
      markHeight: world.markHeight
    });
    const lines = fs
      .readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // One status, the mark's.
    const statuses = lines.filter((l) => l.path === '/v1/status');
    expect(statuses).toHaveLength(1);
    expect(JSON.parse(statuses[0].body).data.finalized.height).toBe(
      world.markHeight
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'))
    ).toMatchObject({ made_by: 'a test of the capture' });
  });

  it('replays: a rebuild asks nothing the recording lacks and reads the same', async () => {
    await captureWavesGateway({
      gateway: node.url,
      dir,
      madeBy: 'a test of the capture',
      pollMs: 10,
      waitForMark: async () => undefined
    });
    const replay = await startHttpRecording({ name: 'gateway', dir });
    try {
      const replayed = new FakeIndexDb();
      const heights = await indexChainTo(
        gatewayChainIndexSource(replay.url),
        replayed.asDb(),
        null
      );
      expect(heights).toEqual([world.doneHeight, world.markHeight]);
      expect(replay.problems()).toEqual([]);
      const direct = new FakeIndexDb();
      await indexChainTo(
        gatewayChainIndexSource(node.url),
        direct.asDb(),
        null
      );
      expect(snapshot(replayed)).toEqual(snapshot(direct));
    } finally {
      await replay.stop();
    }
  });
});
