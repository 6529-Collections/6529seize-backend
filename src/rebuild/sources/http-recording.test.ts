import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  exchangeKey,
  startHttpRecording,
  withRequestIds
} from '@/rebuild/sources/http-recording';
import {
  closeServer,
  listenLoopback,
  readProvenance,
  redactUrl,
  writeProvenance
} from '@/rebuild/sources/running-source';

const rpc = (id: number, method: string) =>
  Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }));

describe('HTTP recording', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-recording-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keys requests without JSON-RPC ids, key order or query order', () => {
    expect(exchangeKey('POST', '/', rpc(1, 'eth_chainId'))).toBe(
      exchangeKey('POST', '/', rpc(99, 'eth_chainId'))
    );
    expect(exchangeKey('GET', '/a?y=2&x=1', Buffer.alloc(0))).toBe(
      exchangeKey('GET', '/a?x=1&y=2', Buffer.alloc(0))
    );
    expect(exchangeKey('POST', '/', Buffer.from('{"b":1,"a":2}'))).toBe(
      exchangeKey('POST', '/', Buffer.from('{"a":2,"b":1}'))
    );
    expect(exchangeKey('POST', '/', rpc(1, 'eth_chainId'))).not.toBe(
      exchangeKey('POST', '/', rpc(1, 'eth_blockNumber'))
    );
  });

  it('puts the request ids back into a recorded answer, batches too', () => {
    expect(
      JSON.parse(
        withRequestIds(rpc(7, 'x'), '{"jsonrpc":"2.0","id":1,"result":"0x1"}')
      )
    ).toEqual({ jsonrpc: '2.0', id: 7, result: '0x1' });
    const batch = Buffer.from(
      JSON.stringify([
        { jsonrpc: '2.0', id: 5, method: 'a' },
        { jsonrpc: '2.0', id: 6, method: 'b' }
      ])
    );
    expect(
      JSON.parse(
        withRequestIds(batch, '[{"id":1,"result":1},{"id":2,"result":2}]')
      )
    ).toEqual([
      { id: 5, result: 1 },
      { id: 6, result: 2 }
    ]);
  });

  it('records through to the upstream, then replays without it', async () => {
    let calls = 0;
    const upstream = http.createServer((request, response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: request.url })
      );
    });
    const { url: upstreamUrl } = await listenLoopback(upstream);
    const recorder = await startHttpRecording({
      name: 'gateway',
      dir,
      upstream: upstreamUrl
    });
    const ask = async (base: string, id: number) =>
      (
        await fetch(`${base}/v1/head`, {
          method: 'POST',
          body: rpc(id, 'head')
        })
      ).json();
    expect(await ask(recorder.url, 3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: '/v1/head'
    });
    await recorder.stop();
    await closeServer(upstream);

    const replay = await startHttpRecording({ name: 'gateway', dir });
    try {
      expect(await ask(replay.url, 4)).toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: '/v1/head'
      });
      expect(calls).toBe(1);
      const missing = await fetch(`${replay.url}/v1/other`);
      expect(missing.status).toBe(599);
      expect(replay.problems()).toEqual([
        'gateway: 1 requests not in the recording, first GET /v1/other'
      ]);
      expect(replay.info).toMatchObject({
        mode: 'replay',
        provenance: `record of ${upstreamUrl}`,
        provisional: false
      });
    } finally {
      await replay.stop();
    }
  });

  it('counts a recording run as provisional and keeps a hand-written provenance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-hand-'));
    try {
      writeProvenance(dir, { made_by: 'hand' });
      const recorder = await startHttpRecording({
        name: 'gateway',
        dir,
        upstream: 'http://192.0.2.1/v1?key=secret'
      });
      expect(recorder.info.provisional).toBe(true);
      await recorder.stop();
      expect(readProvenance(dir)).toEqual({ made_by: 'hand' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('redactUrl', () => {
  it('drops credentials, query values and key-like path segments', () => {
    expect(
      redactUrl(
        'https://user:pw@eth.example/v2/abcdefghijklmnopqrstuvwxyz?apikey=k&a=1'
      )
    ).toBe('https://eth.example/v2/REDACTED?apikey=REDACTED&a=REDACTED');
    expect(redactUrl('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
    expect(redactUrl('not a url')).toBe('REDACTED');
  });
});
