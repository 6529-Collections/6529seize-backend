import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ChainGatewayClient,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import { closeServer, listenLoopback } from '@/rebuild/sources/running-source';
import {
  gatewayChainIndexSource,
  indexChainTo
} from '@/rebuild/steps/waves-chain-index.steps';
import { FakeIndexDb } from '@/tests/fixtures/waves-chain-index.fixture';
import {
  captureWavesGateway,
  documentCids,
  readDocuments,
  startRecorder
} from './gateway-capture';
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

  it('starts after an import height the node never finalized, and replays the same', async () => {
    const skipped: WavesGatewayWorld = {
      ...world,
      headViews: new Set([world.doneHeight, world.doneHeight + 1])
    };
    const skippedNode = await startGatewayWorld(skipped);
    try {
      const result = await captureWavesGateway({
        gateway: skippedNode.url,
        dir,
        madeBy: 'a test of the capture',
        pollMs: 10,
        waitForMark: async () => undefined
      });
      expect(result).toMatchObject({
        doneHeight: world.doneHeight,
        startHeight: world.doneHeight + 2,
        markHeight: world.markHeight
      });
      const replay = await startHttpRecording({ name: 'gateway', dir });
      try {
        const replayed = new FakeIndexDb();
        expect(
          await indexChainTo(
            gatewayChainIndexSource(replay.url),
            replayed.asDb(),
            null
          )
        ).toEqual([world.doneHeight + 2, world.markHeight]);
        expect(replay.problems()).toEqual([]);
        const direct = new FakeIndexDb();
        await indexChainTo(
          gatewayChainIndexSource(skippedNode.url),
          direct.asDb(),
          null
        );
        expect(snapshot(replayed)).toEqual(snapshot(direct));
      } finally {
        await replay.stop();
      }
    } finally {
      await skippedNode.close();
    }
  });
});

describe('the capture of documents', () => {
  const bytes = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0x7d]);
  const cid = `0x01551220${createHash('sha256').update(bytes).digest('hex')}`;
  const absent = `0x01551220${'00'.repeat(32)}`;
  let dir: string;
  let store: http.Server;
  let storeUrl: string;

  beforeAll(async () => {
    // A document store: one document, the store's own "none" for others.
    store = http.createServer((request, response) => {
      if (request.url === `/v1/docs/${cidPath(cid)}`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(bytes);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'not_found',
            message: 'this store holds no document with that CID'
          }
        })
      );
    });
    storeUrl = (await listenLoopback(store)).url;
  });

  afterAll(async () => {
    await closeServer(store);
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-gateway-docs-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds sha2-256 CIDs in fields ending in Cid, once each', () => {
    const base32 = cidPath(cid);
    const json = (value: unknown) => ({
      body: JSON.stringify(value),
      encoding: 'utf8' as const
    });
    expect(
      documentCids([
        json({ data: [{ metadataCid: cid, policyHash: cid }] }),
        json({ data: { entry: { data: { contentCid: base32 } } } }),
        json({ data: { ballotCid: `0x${'c5'.repeat(32)}`, otherCid: 7 } }),
        {
          body: Buffer.from(cid).toString('base64'),
          encoding: 'base64' as const
        },
        json({
          data: { metadataCid: absent.toUpperCase().replace('0X', '0x') }
        })
      ])
    ).toEqual([cid, absent]);
  });

  it('keeps a document byte for byte, and a replay serves it to the gateway client', async () => {
    const recorder = await startRecorder(storeUrl, dir);
    try {
      expect(await readDocuments(recorder.url, [cid, absent])).toEqual({
        read: 2,
        missing: 1
      });
    } finally {
      await recorder.stop();
    }
    const replay = await startHttpRecording({ name: 'gateway', dir });
    try {
      const client = new ChainGatewayClient(() => ({
        baseUrl: replay.url,
        serviceKey: null,
        timeoutMs: 5_000,
        retries: 0,
        headTtlMs: 0,
        cacheEntries: 10
      }));
      expect(await client.getDocument(cid)).toEqual(bytes);
      expect(await client.getDocument(absent)).toBeNull();
      expect(replay.problems()).toEqual([]);
    } finally {
      await replay.stop();
    }
  });
});
