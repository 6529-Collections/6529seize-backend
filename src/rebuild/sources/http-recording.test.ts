import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  exchangeKey,
  startHttpRecording,
  upstreamTarget,
  withRequestIds
} from '@/rebuild/sources/http-recording';
import {
  closeServer,
  errorText,
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
      // Nothing verifies a recording's answers: never final on its label.
      expect(replay.info).toMatchObject({
        mode: 'replay',
        provenance: `record of ${upstreamUrl}`,
        provisional: true,
        provisionalWhy: 'answers not verified'
      });
    } finally {
      await replay.stop();
    }
  });

  it('answers a failed request with a fixed message and reports the error', async () => {
    // fetch refuses a URL with credentials before connecting.
    const recorder = await startHttpRecording({
      name: 'gateway',
      dir,
      upstream: 'http://user:secret@127.0.0.1:9'
    });
    try {
      const answer = await fetch(`${recorder.url}/v1/head`, {
        method: 'POST',
        body: rpc(1, 'head')
      });
      expect(answer.status).toBe(502);
      expect(await answer.text()).toBe('{"error":"replay failed"}');
      const problems = recorder.problems();
      expect(problems).toEqual([
        expect.stringMatching(
          /^gateway: 1 requests failed in the recording's server, first POST \/v1\/head: TypeError: .*http:\/\/127\.0\.0\.1:9\/v1\/head/
        )
      ]);
      expect(problems.join('\n')).not.toContain('secret');
    } finally {
      await recorder.stop();
    }
  });

  it('never counts a gateway or ethereum recording on its label', async () => {
    fs.writeFileSync(path.join(dir, 'recording.jsonl'), '');
    writeProvenance(dir, { made_by: 'devnet example' });
    const ethereum = await startHttpRecording({ name: 'ethereum', dir });
    const gateway = await startHttpRecording({ name: 'gateway', dir });
    try {
      for (const source of [ethereum, gateway]) {
        expect(source.info).toMatchObject({
          mode: 'replay',
          provenance: 'devnet example',
          provisional: true,
          provisionalWhy: 'answers not verified'
        });
      }
    } finally {
      await ethereum.stop();
      await gateway.stop();
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

describe('upstreamTarget', () => {
  it("puts a request's path and query on the upstream's origin and path", () => {
    const at = (upstream: string, request: string) =>
      upstreamTarget(new URL(upstream), request)?.href;
    expect(at('http://192.0.2.1:8545', '/v1/blocks/7?height=9')).toBe(
      'http://192.0.2.1:8545/v1/blocks/7?height=9'
    );
    expect(at('http://192.0.2.1/v2/key/', '/nft?id=1')).toBe(
      'http://192.0.2.1/v2/key/nft?id=1'
    );
    expect(at('http://192.0.2.1/v2/key', '/')).toBe('http://192.0.2.1/v2/key/');
    // The upstream's own query stays, the request's after it.
    expect(at('http://192.0.2.1/v1?key=k', '/x?y=1')).toBe(
      'http://192.0.2.1/v1/x?key=k&y=1'
    );
    expect(at('http://192.0.2.1/v1?key=k', '/x')).toBe(
      'http://192.0.2.1/v1/x?key=k'
    );
  });

  it('refuses a target that would leave the upstream', () => {
    const upstream = new URL('http://192.0.2.1/v2/key');
    for (const target of [
      '//evil.example/x',
      'http://evil.example/x',
      '@evil.example',
      'evil.example/x',
      '/../..',
      '/../other',
      '/x/%2e%2e/%2e%2e/other',
      '/..\\..\\other',
      ''
    ]) {
      expect([target, upstreamTarget(upstream, target)]).toEqual([
        target,
        null
      ]);
    }
    // A target only spelled oddly stays on the upstream.
    for (const odd of ['/@evil.example', '/\\evil.example']) {
      expect(upstreamTarget(upstream, odd)?.origin).toBe('http://192.0.2.1');
    }
  });

  it('answers a refused target 400 in a recording run, and never fetches it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-refused-'));
    const seen: (string | undefined)[] = [];
    const upstream = http.createServer((request, response) => {
      seen.push(request.url);
      response.end('{}');
    });
    const { url: upstreamUrl } = await listenLoopback(upstream);
    const recorder = await startHttpRecording({
      name: 'gateway',
      dir,
      upstream: `${upstreamUrl}/api`
    });
    const send = (target: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const { hostname, port } = new URL(recorder.url);
        const request = http.request(
          { hostname, port, path: target, method: 'GET' },
          (response) => {
            let body = '';
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode ?? 0, body })
            );
          }
        );
        request.on('error', reject);
        request.end();
      });
    try {
      expect(await send('/v1/head')).toEqual({ status: 200, body: '{}' });
      for (const target of [
        'http://evil.example/x',
        '//evil.example/x',
        '/../x',
        '/%2e%2e/x'
      ]) {
        expect(await send(target)).toEqual({
          status: 400,
          body: '{"error":"not a path under the upstream"}'
        });
      }
      // Only the path under the upstream was fetched.
      expect(seen).toEqual(['/api/v1/head']);
      expect(recorder.problems()).toEqual([
        'gateway: 4 requests refused, not a path under the upstream, first GET http://evil.example/x, GET //evil.example/x, GET /../x'
      ]);
    } finally {
      await recorder.stop();
      await closeServer(upstream);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('errorText', () => {
  it("adds a failed fetch's cause", () => {
    const failed = (cause: unknown) =>
      Object.assign(new TypeError('fetch failed'), { cause });
    expect(
      errorText(failed(new Error('connect ECONNREFUSED 127.0.0.1:9')))
    ).toBe('TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:9)');
    // Every address refused: no message, only a code.
    expect(
      errorText(failed(Object.assign(new Error(''), { code: 'ECONNREFUSED' })))
    ).toBe('TypeError: fetch failed (ECONNREFUSED)');
    expect(errorText(failed({ message: 'from another realm' }))).toBe(
      'TypeError: fetch failed (from another realm)'
    );
    expect(errorText(new Error('plain'))).toBe('Error: plain');
    expect(errorText('text')).toBe('text');
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
