import {
  DeliveryProbeDeps,
  DeliveryProbeOptions,
  probeContent,
  probeIndexOfFrame,
  ProbeSocket,
  runDeliveryProbe
} from './delivery-probe';
import {
  distribution,
  percentile,
  summarizeProbe
} from './delivery-probe-stats';
import { parseProbeArgs } from './delivery-probe.cli';

class FakeSocket implements ProbeSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data);
    if (message.type === 'AUTHENTICATE') {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ type: 'AUTHENTICATED' }) })
      );
    }
  }

  close(): void {
    this.closed = true;
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const baseOptions: DeliveryProbeOptions = {
  apiBase: 'https://api.example.test',
  wsUrl: 'wss://ws.example.test',
  waveId: 'wave-1',
  count: 3,
  intervalMs: 0,
  posterJwt: 'poster',
  listenerJwt: 'listener',
  listenerMode: 'app',
  listeners: 2,
  settleMs: 0,
  connectTimeoutMs: 1_000,
  runId: 'run1'
};

function harness(options: Partial<DeliveryProbeOptions> = {}) {
  let clock = 1_000;
  const sockets: FakeSocket[] = [];
  const requests: {
    url: string;
    body: any;
    headers: Record<string, string>;
  }[] = [];
  const deps: DeliveryProbeDeps = {
    now: () => clock,
    sleep: async () => undefined,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body, headers: init.headers });
      const index = requests.length - 1;
      const dropId = `drop-${index}`;
      clock += 10;
      // Listener 0 gets the frame before the POST returns; listener 1 after.
      sockets[0].receive({
        type: 'DROP_UPDATE',
        data: { id: dropId, parts: [{ content: body.parts[0].content }] },
        server_received_at: 500,
        sent_at: 530
      });
      if (index === 1) {
        // A duplicate copy on the same socket.
        sockets[0].receive({
          type: 'DROP_UPDATE',
          data: { id: dropId, parts: [{ content: body.parts[0].content }] }
        });
      }
      clock += 5;
      return {
        status: index === 2 ? 500 : 201,
        json: async () => ({ id: dropId })
      };
    }
  };
  return {
    deps,
    sockets,
    requests,
    advance: (ms: number) => {
      clock += ms;
    },
    options: { ...baseOptions, ...options }
  };
}

describe('delivery probe', () => {
  it('times delivery per listener on one clock and flags duplicates', async () => {
    const h = harness();
    const run = runDeliveryProbe(h.options, {
      ...h.deps,
      sleep: async () => {
        // Listener 1 receives each successful post 20 ms after the response.
        for (const request of h.requests) {
          const index = h.requests.indexOf(request);
          if (index === 2) continue;
          if (!(request as any).deliveredToSecond) {
            (request as any).deliveredToSecond = true;
            h.advance(20);
            h.sockets[1].receive({
              type: 'DROP_UPDATE_REF',
              data: { drop_id: `drop-${index}`, update_type: 'DROP_UPDATE' }
            });
          }
        }
      }
    });
    const result = await run;

    expect(h.requests).toHaveLength(3);
    expect(h.requests[0].url).toBe('https://api.example.test/api/drops');
    expect(h.requests[0].headers.authorization).toBe('Bearer poster');
    expect(h.requests[0].body.parts[0].content).toBe(probeContent('run1', 0));
    for (const socket of h.sockets) {
      expect(new URL(socket.url).searchParams.get('recovery_capability')).toBe(
        'resync_v1'
      );
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: 'AUTHENTICATE',
        access_token: 'listener'
      });
      expect(socket.closed).toBe(true);
    }
    expect(result.summary).toMatchObject({
      posts: 3,
      failedPosts: 1,
      listeners: 2,
      deliveredBeforeResponse: 2,
      missing: 0,
      duplicates: 1
    });
    expect(result.summary.postResponseMs).toMatchObject({ p50: 15, max: 15 });
    expect(result.summary.serverFanoutMs).toMatchObject({ count: 2, p50: 30 });
    expect(result.summary.lastListenerDeliveryMs.count).toBe(2);
  });

  it('subscribes listeners to the wave in open-wave mode', async () => {
    const h = harness({ listenerMode: 'open-wave', listeners: 1, count: 1 });
    await runDeliveryProbe(h.options, h.deps);
    expect(JSON.parse(h.sockets[0].sent[1])).toEqual({
      type: 'SUBSCRIBE_TO_WAVE',
      wave_id: 'wave-1'
    });
  });

  it('fails fast when the listener cannot authenticate', async () => {
    const h = harness();
    await expect(
      runDeliveryProbe(h.options, {
        ...h.deps,
        createSocket: (url) => {
          const socket = new FakeSocket(url);
          socket.send = () =>
            queueMicrotask(() =>
              socket.receive({ type: 'AUTHENTICATION_FAILED' })
            );
          queueMicrotask(() => socket.onopen?.());
          return socket;
        }
      })
    ).rejects.toThrow('listener authentication failed');
  });

  it('only matches frames from this run', () => {
    const ids = new Map([['drop-7', 7]]);
    expect(
      probeIndexOfFrame(
        {
          type: 'DROP_UPDATE',
          data: { id: 'x', parts: [{ content: probeContent('run1', 4) }] }
        },
        'run1',
        ids
      )
    ).toBe(4);
    expect(
      probeIndexOfFrame(
        {
          type: 'DROP_UPDATE',
          data: { id: 'x', parts: [{ content: probeContent('other', 4) }] }
        },
        'run1',
        ids
      )
    ).toBeNull();
    expect(
      probeIndexOfFrame(
        {
          type: 'DROP_UPDATE_REF',
          data: { drop_id: 'drop-7', update_type: 'DROP_REACTION_UPDATE' }
        },
        'run1',
        ids
      )
    ).toBeNull();
    expect(probeIndexOfFrame({ type: 'USER_IS_TYPING' }, 'run1', ids)).toBe(
      null
    );
  });
});

describe('delivery probe statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([], 50)).toBeNull();
    expect(distribution([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null
    });
  });

  it('counts missing receipts only for successful posts', () => {
    const summary = summarizeProbe({
      posts: [
        { index: 0, postedAt: 0, respondedAt: 50, dropId: 'a', status: 201 },
        { index: 1, postedAt: 0, respondedAt: null, dropId: null, status: 500 }
      ],
      receipts: [
        {
          index: 1,
          listener: 0,
          receivedAt: 10,
          serverReceivedAt: null,
          sentAt: null
        }
      ],
      listeners: 2
    });
    expect(summary).toMatchObject({ failedPosts: 1, missing: 2 });
  });
});

describe('delivery probe arguments', () => {
  it('derives the socket URL and reads tokens from the environment', () => {
    const options = parseProbeArgs(
      ['--api', 'https://api.staging.6529.io/', '--wave', 'wave-1', '--json'],
      { PROBE_POSTER_JWT: 'p', PROBE_STAGING_AUTH: 's' }
    );
    expect(options).toMatchObject({
      apiBase: 'https://api.staging.6529.io',
      wsUrl: 'wss://ws.staging.6529.io',
      waveId: 'wave-1',
      count: 100,
      listeners: 1,
      listenerMode: 'app',
      posterJwt: 'p',
      listenerJwt: null,
      stagingAuth: 's',
      json: true
    });
  });

  it('rejects unsafe or missing inputs', () => {
    expect(parseProbeArgs(['--help'], {})).toBeNull();
    expect(() =>
      parseProbeArgs(['--api', 'https://a', '--wave', 'w'], {})
    ).toThrow('PROBE_POSTER_JWT');
    expect(() =>
      parseProbeArgs(
        ['--api', 'https://api.a', '--wave', 'w', '--count', '0'],
        { PROBE_POSTER_JWT: 'p' }
      )
    ).toThrow('--count');
    expect(() =>
      parseProbeArgs(['--api', 'https://example.test', '--wave', 'w'], {
        PROBE_POSTER_JWT: 'p'
      })
    ).toThrow('--ws is required');
    expect(() =>
      parseProbeArgs(
        ['--api', 'https://example.test', '--wave', 'w', '--ws', 'https://x'],
        { PROBE_POSTER_JWT: 'p' }
      )
    ).toThrow('--ws must be a ws(s) URL');
    expect(() =>
      parseProbeArgs(['--api', 'ftp://a', '--wave', 'w'], {
        PROBE_POSTER_JWT: 'p'
      })
    ).toThrow('--api');
  });
});
