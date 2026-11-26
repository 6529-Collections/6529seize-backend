import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Probe } from '@/rebuild/manifest.types';
import {
  accessToken,
  answeredOnRetry,
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
        body: { url: '/x', auth: null },
        json: true
      });
      expect((answers.b.body as { auth: string }).auth).toMatch(/^Bearer /);
      expect(answers.c.body).toEqual({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
      expect(answers.c.json).toBe(false);
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
      ...expandProbe('l', { id: 'data', path: '/balances/0x0a' }),
      ...expandProbe('l', { id: 'empty-then-not', path: '/11' }),
      ...expandProbe('l', { id: 'csv', path: '/12' }),
      ...expandProbe('l', { id: 'blank', path: '/13' }),
      ...expandProbe('l', { id: 'ok-empty', path: '/14', expectStatus: 200 }),
      ...expandProbe('l', { id: 'gone-then-back', path: '/15' })
    ];
    const answer = (
      id: string,
      status: number,
      body: unknown,
      json = true
    ): ProbeAnswer => ({
      id,
      status,
      body,
      json
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
      data: answer('data', 200, { wallet: '0x0a', balance: 3 }),
      'empty-then-not': answer('empty-then-not', 200, []),
      csv: answer('csv', 200, { sha256: 'ab' }, false),
      blank: answer('blank', 200, { sha256: 'e3' }, false),
      'ok-empty': answer('ok-empty', 200, { data: [] }),
      'gone-then-back': answer('gone-then-back', 404, { error: 'not found' })
    };
    const after = {
      ...before,
      same: answer('same', 200, { b: 2, a: 1 }),
      ignored: answer('ignored', 200, { v: 1, t: 2 }),
      differs: answer('differs', 200, { v: 2 }),
      'empty-then-not': answer('empty-then-not', 200, [{ id: 1 }]),
      'gone-then-back': answer('gone-then-back', 200, { id: 1 })
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
      ['echo', 'unproven', 'the first pass answered with no data'],
      ['empty-then-not', 'failure', 'the answers differ'],
      ['csv', 'unproven', 'the first pass answered without JSON'],
      ['blank', 'unproven', 'the first pass answered without JSON'],
      ['ok-empty', 'unproven', 'the first pass answered with no data'],
      ['gone-then-back', 'failure', 'the answers differ']
    ]);
  });

  describe('a request the API never answered', () => {
    const json = (status: number) =>
      new Response(JSON.stringify({ ok: status }), {
        status,
        headers: { 'content-type': 'application/json' }
      });
    let fetchSpy: jest.SpyInstance;
    afterEach(() => jest.restoreAllMocks());

    it('sends a GET once more when its fetch threw, and notes the second try', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(json(200));
      const answers = await runProbes(
        'http://127.0.0.1:9',
        expandProbe('l', { id: 'g', path: '/g' }),
        'secret'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(answers.g).toEqual({
        id: 'g',
        status: 200,
        body: { ok: 200 },
        json: true,
        attempts: 2
      });
      expect(answeredOnRetry({}, answers)).toEqual(['g (pass B)']);
    });

    it('gives a GET that got no answer twice the error, as status 0', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:9')
        })
      );
      const answers = await runProbes(
        'http://127.0.0.1:9',
        expandProbe('l', { id: 'g', path: '/g' }),
        'secret'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(answers.g).toEqual({
        id: 'g',
        status: 0,
        body: null,
        error: 'TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:9)',
        attempts: 2
      });
      expect(answeredOnRetry(answers, {})).toEqual([]);
    });

    it('never sends a POST again: it may have written before the connection dropped', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new TypeError('fetch failed'));
      const answers = await runProbes(
        'http://127.0.0.1:9',
        expandProbe('l', {
          id: 'p',
          path: '/p',
          method: 'POST',
          body: { a: 1 }
        }),
        'secret'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(answers.p).toEqual({
        id: 'p',
        status: 0,
        body: null,
        error: 'TypeError: fetch failed'
      });
    });

    it('never sends again a request that got an answer, a 5xx included', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(json(503));
      const answers = await runProbes(
        'http://127.0.0.1:9',
        expandProbe('l', { id: 'g', path: '/g' }),
        'secret'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(answers.g).toMatchObject({ status: 503 });
      expect(answers.g.attempts).toBeUndefined();
    });

    it('keeps the status of an answer whose body broke off, and sends it once', async () => {
      const broken = new ReadableStream({
        pull(controller) {
          controller.error(new Error('socket hang up'));
        }
      });
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(broken, { status: 500 }));
      const answers = await runProbes(
        'http://127.0.0.1:9',
        expandProbe('l', { id: 'g', path: '/g' }),
        'secret'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(answers.g).toEqual({
        id: 'g',
        status: 0,
        body: null,
        error: expect.stringMatching(
          /^the answer's body \(status 500\) broke off: .*socket hang up/
        )
      });
    });

    it('reports an unanswered probe apart from the differences, in either pass', () => {
      const calls = [
        ...expandProbe('l', { id: 'a', path: '/a' }),
        ...expandProbe('l', { id: 'b', path: '/b' }),
        ...expandProbe('l', { id: 'post', path: '/p', method: 'POST' }),
        ...expandProbe('l', { id: 'five', path: '/5' }),
        ...expandProbe('l', { id: 'wrong', path: '/w', expectStatus: 404 })
      ];
      const ok: ProbeAnswer = { id: 'x', status: 200, body: { v: 1 } };
      const none = (attempts?: number): ProbeAnswer => ({
        id: 'x',
        status: 0,
        body: null,
        error: 'TypeError: fetch failed',
        ...(attempts ? { attempts } : {})
      });
      expect(
        diffAnswers(
          calls,
          {
            a: none(2),
            b: ok,
            post: ok,
            five: { id: 'five', status: 503, body: {} },
            wrong: ok
          },
          { a: ok, b: none(2), post: none(), five: none(2), wrong: none(2) }
        ).map((d) => [d.id, d.kind, d.reason])
      ).toEqual([
        [
          'a',
          'unanswered',
          "the API didn't answer in pass A, 2 tries: TypeError: fetch failed"
        ],
        [
          'b',
          'unanswered',
          "the API didn't answer in pass B, 2 tries: TypeError: fetch failed"
        ],
        [
          'post',
          'unanswered',
          "the API didn't answer in pass B: TypeError: fetch failed"
        ],
        // A first pass that failed stays a failure, whatever pass B got.
        ['five', 'failure', 'the first pass failed'],
        ['wrong', 'failure', 'the first pass answered 200, not 404']
      ]);
    });
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
