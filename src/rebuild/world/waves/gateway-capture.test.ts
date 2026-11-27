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
  gatewayBase,
  mirrorReadTargets,
  PROXY_FAILED,
  readMirrorExtras,
  startRecorder,
  upstreamTarget
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

  it("records the chain mirror's own reads at the mark, as its client asks them", async () => {
    const result = await captureWavesGateway({
      gateway: node.url,
      dir,
      madeBy: 'a test of the capture',
      pollMs: 10,
      waitForMark: async () => undefined
    });
    expect(result.mirrorReads.blocks).toBeGreaterThan(0);
    expect(result.mirrorReads.policies).toBeGreaterThan(0);
    const keys = fs
      .readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).path as string);
    const blocks = keys.filter((p) => p.startsWith('/v1/blocks/'));
    const policies = keys.filter((p) =>
      /\/v1\/decisions\/[^/]+\/policies/.test(p)
    );
    expect(blocks).toHaveLength(result.mirrorReads.blocks);
    expect(policies).toHaveLength(result.mirrorReads.policies);
    // Pinned at the mark on the world's network, as the mirror's reads are.
    for (const p of [...blocks, ...policies]) {
      expect(p).toContain(`height=${world.markHeight}`);
      expect(p).toContain('network=');
    }
    // A replay answers the mirror's block read from the recording.
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
      const height = Number(blocks[0].split('/')[3].split('?')[0]);
      const answer = await client.read<{ time: number }>(
        `/v1/blocks/${height}`
      );
      expect(answer?.data.time).toBeGreaterThan(0);
      expect(replay.problems()).toEqual([]);
    } finally {
      await replay.stop();
    }
  });

  it("fails the capture when the node can't answer one of the mirror's reads", async () => {
    // The world, except that every block read fails on the node's side.
    let blockReads = 0;
    const broken = http.createServer((request, response) => {
      if ((request.url ?? '').startsWith('/v1/blocks/')) {
        blockReads++;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'broken' }));
        return;
      }
      fetch(`${node.url}${request.url}`).then(async (answer) => {
        response.writeHead(answer.status, {
          'content-type':
            answer.headers.get('content-type') ?? 'application/json'
        });
        response.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
    const url = (await listenLoopback(broken)).url;
    const recorder = await startRecorder(url, dir);
    try {
      await expect(
        readMirrorExtras(recorder.url, () => [
          {
            body: JSON.stringify({ data: { updatedHeight: 5 } }),
            encoding: 'utf8' as const
          }
        ])
      ).rejects.toThrow("The capture of the mirror's read /v1/blocks/5 failed");
      // Each retry reached the node, and no failure was kept.
      expect(blockReads).toBeGreaterThan(1);
      expect(
        fs.readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')
      ).not.toContain('/v1/blocks/');
    } finally {
      await recorder.stop();
      await closeServer(broken);
    }
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

describe("the chain mirror's read targets", () => {
  const json = (value: unknown) => ({
    body: JSON.stringify(value),
    encoding: 'utf8' as const
  });

  it('take every vote, result and policy height, and the chain-made decisions', () => {
    expect(
      mirrorReadTargets([
        json({
          data: [
            { decisionId: '0xAB', origin: 'native', updatedHeight: '12' },
            { decisionId: '0xcd', origin: 'legacy', updatedHeight: 7 }
          ]
        }),
        json({ data: { data: { settledHeight: '30' }, other: 99 } }),
        json({ data: [{ version: 1, activationHeight: '5' }] }),
        json({ data: { settledHeight: '0', updatedHeight: 'soon' } }),
        { body: 'not json', encoding: 'utf8' as const },
        { body: 'AAAA', encoding: 'base64' as const }
      ])
    ).toEqual({ heights: [5, 7, 12, 30], decisions: ['0xab'] });
  });
});

describe('the capture recorder', () => {
  const bytes = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0x7d]);
  const cid = `0x01551220${createHash('sha256').update(bytes).digest('hex')}`;
  let dir: string;
  let node: http.Server;
  let nodeUrl: string;

  beforeAll(async () => {
    // A node answering a document and another binary answer.
    node = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(bytes);
    });
    nodeUrl = (await listenLoopback(node)).url;
  });

  afterAll(async () => {
    await closeServer(node);
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-gateway-recorder-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = async (url: string) =>
    Buffer.from(await (await fetch(url)).arrayBuffer());

  it('passes document reads through and records none of them', async () => {
    const recorder = await startRecorder(nodeUrl, dir);
    try {
      expect(await read(`${recorder.url}/v1/docs/${cidPath(cid)}`)).toEqual(
        bytes
      );
      expect(await read(`${recorder.url}/v1/docs?cid=${cid}`)).toEqual(bytes);
    } finally {
      await recorder.stop();
    }
    expect(fs.readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')).toBe('');
  });

  it('keeps an answer that is not text byte for byte, and replays it', async () => {
    const recorder = await startRecorder(nodeUrl, dir);
    try {
      expect(await read(`${recorder.url}/v1/blob`)).toEqual(bytes);
    } finally {
      await recorder.stop();
    }
    const lines = fs
      .readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ path: '/v1/blob', encoding: 'base64' });
    const replay = await startHttpRecording({ name: 'gateway', dir });
    try {
      expect(await read(`${replay.url}/v1/blob`)).toEqual(bytes);
      expect(replay.problems()).toEqual([]);
    } finally {
      await replay.stop();
    }
  });

  it('answers a request it could not forward with a fixed text, and logs the request and its cause', async () => {
    // A node that drops every connection: the fetch fails, and why is in
    // the failure's cause. It keeps listening, so no other server can
    // take its port before the request.
    const dropping = http.createServer();
    dropping.on('connection', (socket) => socket.destroy());
    const droppingUrl = (await listenLoopback(dropping)).url;
    const recorder = await startRecorder(droppingUrl, dir);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answer = await fetch(`${recorder.url}/v1/status`);
      expect(answer.status).toBe(502);
      expect(await answer.json()).toEqual({ error: PROXY_FAILED });
      expect(logged).toHaveBeenCalledTimes(1);
      // The fetch's own text, then its cause in brackets (errorText).
      expect(String(logged.mock.calls[0][0])).toMatch(
        /^\[GATEWAY CAPTURE\] the recording proxy could not answer GET \/v1\/status: TypeError: fetch failed \(.+\)$/
      );
    } finally {
      logged.mockRestore();
      await recorder.stop();
      await closeServer(dropping);
    }
    expect(fs.readFileSync(path.join(dir, 'recording.jsonl'), 'utf8')).toBe('');
  });
});

describe('the recorder sends a request only to the gateway it was given', () => {
  it('takes an http or https gateway with no credentials, query or fragment', () => {
    expect(gatewayBase('http://192.0.2.10:8545').href).toBe(
      'http://192.0.2.10:8545/'
    );
    expect(gatewayBase('https://192.0.2.10/api').pathname).toBe('/api');
    for (const bad of [
      'file:///etc/hosts',
      'ftp://192.0.2.10/',
      'http://user:pass@192.0.2.10/',
      'http://192.0.2.10/?x=1',
      'http://192.0.2.10/#x',
      'not a url'
    ]) {
      expect(() => gatewayBase(bad)).toThrow();
    }
  });

  it("puts a request's path and query on the gateway's own origin and path", () => {
    const base = gatewayBase('http://192.0.2.10:8545');
    expect(
      upstreamTarget(base, '/v1/blocks/7?height=9&network=0x01')?.href
    ).toBe('http://192.0.2.10:8545/v1/blocks/7?height=9&network=0x01');
    expect(
      upstreamTarget(gatewayBase('http://192.0.2.10/api/'), '/v1/status')?.href
    ).toBe('http://192.0.2.10/api/v1/status');
  });

  it('refuses a request that would leave the gateway', () => {
    const base = gatewayBase('http://192.0.2.10:8545');
    for (const bad of [
      'http://198.51.100.7/v1/status',
      '//198.51.100.7/v1/status',
      'v1/status',
      ''
    ]) {
      expect(upstreamTarget(base, bad)).toBeNull();
    }
    expect(upstreamTarget(base, '/v1/../../x')?.origin).toBe(
      'http://192.0.2.10:8545'
    );
  });

  it("keeps a request under a gateway's path, whatever its dot segments", () => {
    const base = gatewayBase('http://192.0.2.10/api');
    for (const escape of [
      '/../admin',
      '/%2e%2e/admin',
      '/.%2E/admin',
      '/..\\admin'
    ]) {
      expect(upstreamTarget(base, escape)).toBeNull();
    }
    expect(upstreamTarget(base, '/v1/waves/../status')?.href).toBe(
      'http://192.0.2.10/api/v1/status'
    );
    expect(upstreamTarget(base, '/v1/status?height=3')?.href).toBe(
      'http://192.0.2.10/api/v1/status?height=3'
    );
  });

  it('refuses a gateway given with an empty query or fragment', () => {
    expect(() => gatewayBase('http://192.0.2.10/api?')).toThrow();
    expect(() => gatewayBase('http://192.0.2.10/api#')).toThrow();
  });
});
