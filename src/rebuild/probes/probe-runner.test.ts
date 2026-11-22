import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Probe } from '@/rebuild/manifest.types';
import {
  accessToken,
  carriesNoData,
  diffAnswers,
  expandProbe,
  ProbeAnswer,
  runProbes
} from '@/rebuild/probes/probe-runner';

const WALLET = '0x0000000000000000000000000000000000000001';

describe('probe runner', () => {
  it('fills placeholders with every combination of values', () => {
    const calls = expandProbe('area', {
      id: 'p',
      path: '/api/{a}/x/{b}',
      each: { a: ['1', 'two words'], b: ['z'] }
    });
    expect(calls.map((c) => [c.id, c.path])).toEqual([
      ['p[a=1,b=z]', '/api/1/x/z'],
      ['p[a=two words,b=z]', '/api/two%20words/x/z']
    ]);
    expect(expandProbe('area', { id: 'q', path: '/api/q' })[0].id).toBe('q');
  });

  it('signs an access token the JWT strategy accepts', () => {
    const token = accessToken(WALLET.toUpperCase(), 'secret', 1000);
    const [header, payload, signature] = token.split('.');
    expect(
      createHmac('sha256', 'secret')
        .update(`${header}.${payload}`)
        .digest('base64url')
    ).toBe(signature);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({ sub: WALLET, iat: 1000, exp: 1000 + 86400 });
    expect(accessToken(WALLET, 'secret', 1000)).toBe(token);
  });

  it('calls each probe and keeps status and body', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/text') {
        res.end('plain');
        return;
      }
      res.end(
        JSON.stringify({
          url: req.url,
          auth: req.headers.authorization ?? null
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const anonymous: Probe = { id: 'a', path: '/x' };
      const signedIn: Probe = { id: 'b', path: '/y', as: { wallet: WALLET } };
      const text: Probe = { id: 'c', path: '/text' };
      const answers = await runProbes(
        base,
        [
          ...expandProbe('l', anonymous),
          ...expandProbe('l', signedIn),
          ...expandProbe('l', text)
        ],
        'secret'
      );
      expect(answers.a).toEqual({
        id: 'a',
        status: 200,
        body: { url: '/x', auth: null }
      });
      expect((answers.b.body as { auth: string }).auth).toMatch(/^Bearer /);
      expect(answers.c.body).toEqual({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports differences, failures and answers that prove nothing', () => {
    const calls = [
      ...expandProbe('l', { id: 'same', path: '/1' }),
      ...expandProbe('l', {
        id: 'ignored',
        path: '/2',
        ignore: [{ path: '$.t', reason: 'clock' }]
      }),
      ...expandProbe('l', { id: 'differs', path: '/3' }),
      ...expandProbe('l', { id: 'failed', path: '/4' }),
      ...expandProbe('l', { id: 'empty', path: '/5' }),
      ...expandProbe('l', { id: 'gone', path: '/6', expectStatus: 404 }),
      ...expandProbe('l', { id: 'missing', path: '/7' }),
      ...expandProbe('l', { id: 'empty-page', path: '/8' }),
      ...expandProbe('l', {
        id: 'wrong-status',
        path: '/9',
        expectStatus: 404
      }),
      ...expandProbe('l', { id: 'zeros', path: '/10' }),
      ...expandProbe('l', { id: 'echo', path: '/balances/0x0a' }),
      ...expandProbe('l', { id: 'data', path: '/balances/0x0a' })
    ];
    const answer = (
      id: string,
      status: number,
      body: unknown
    ): ProbeAnswer => ({
      id,
      status,
      body
    });
    const before = {
      same: answer('same', 200, { a: 1, b: 2 }),
      ignored: answer('ignored', 200, { v: 1, t: 1 }),
      differs: answer('differs', 200, { v: 1 }),
      failed: answer('failed', 500, { error: 'x' }),
      empty: answer('empty', 200, []),
      gone: answer('gone', 404, { error: 'not found' }),
      missing: answer('missing', 404, { error: 'not found' }),
      'empty-page': answer('empty-page', 200, {
        data: [],
        page: 1,
        next: false
      }),
      'wrong-status': answer('wrong-status', 200, { v: 1 }),
      zeros: answer('zeros', 200, { tdh: 0, rank: 0 }),
      echo: answer('echo', 200, { wallet: '0x0A', balance: 0, last: null }),
      data: answer('data', 200, { wallet: '0x0a', balance: 3 })
    };
    const after = {
      ...before,
      same: answer('same', 200, { b: 2, a: 1 }),
      ignored: answer('ignored', 200, { v: 1, t: 2 }),
      differs: answer('differs', 200, { v: 2 })
    };
    expect(
      diffAnswers(calls, before, after).map((d) => [d.id, d.kind, d.reason])
    ).toEqual([
      ['differs', 'failure', 'the answers differ'],
      ['failed', 'failure', 'the first pass failed'],
      ['empty', 'unproven', 'the first pass answered with no data'],
      ['missing', 'unproven', 'the first pass answered 404'],
      ['empty-page', 'unproven', 'the first pass answered with no data'],
      ['wrong-status', 'failure', 'the first pass answered 200, not 404'],
      ['zeros', 'unproven', 'the first pass answered with no data'],
      ['echo', 'unproven', 'the first pass answered with no data']
    ]);
  });

  it('tells an answer with data from one without', () => {
    expect(carriesNoData(null)).toBe(true);
    expect(carriesNoData({})).toBe(true);
    expect(carriesNoData({ data: [], count: 0, next: null })).toBe(true);
    expect(carriesNoData({ data: [{ id: 1 }], count: 1 })).toBe(false);
    expect(carriesNoData({ data: [], label: 'x' })).toBe(false);
    expect(carriesNoData({ tdh: 0, rank: 0, top: false })).toBe(true);
    expect(carriesNoData({ tdh: 5 })).toBe(false);
    expect(carriesNoData({ has_pending: true })).toBe(false);
    expect(
      carriesNoData(
        { key: '0x0A', mode: { last: null, count: 0 } },
        '/api/subs/0x0a?page=1'
      )
    ).toBe(true);
    expect(carriesNoData({ key: '0x0b' }, '/api/subs/0x0a')).toBe(false);
    expect(carriesNoData(0)).toBe(false);
  });
});
