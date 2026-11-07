/**
 * Lab benchmark for the inline drop fan-out (waves 1.0/1.2).
 *
 * Real MySQL (the Jest testcontainer) holds the audience, a real Redis
 * container holds the delivery bookkeeping, and a local HTTP server stands in
 * for the API Gateway management API with a fixed per-send latency. The real
 * notifier, AppWebSockets, delivery policy and AWS SDK client run unchanged.
 *
 * Not part of `6529 run test` (not a *.test.ts file). Run with:
 *   6529 exec jest --testMatch '**\/*.bench.ts' src/ws-delivery/bench
 * The second part measures waves 1.1 (WS_ASYNC_FANOUT): the request's share
 * (inline budget plus an awaited queue hand-off of BENCH_SQS_MS) and the
 * worker's time per queued chunk. Chunks run in separate Lambdas, so the last
 * recipient waits roughly request share + SQS pickup + the slowest chunk.
 *
 * Tunables: BENCH_RECIPIENTS (1000), BENCH_GATEWAY_MS (20), BENCH_RUNS (5),
 * BENCH_SQS_MS (15),
 * BENCH_REDIS=off (delivery bookkeeping unavailable, as in a Redis outage).
 */
import 'reflect-metadata';
import http from 'node:http';
import { once } from 'node:events';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient } from 'redis';
import { mock } from 'ts-jest-mocker';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WS_CONNECTIONS_TABLE } from '@/constants';

let mockRedis: ReturnType<typeof createClient>;
jest.mock('@/redis', () => ({
  getRedisClient: () =>
    process.env.BENCH_REDIS === 'off' ? undefined : mockRedis
}));

const RECIPIENTS = Number(process.env.BENCH_RECIPIENTS ?? 1000);
const GATEWAY_MS = Number(process.env.BENCH_GATEWAY_MS ?? 20);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const wave = aWave({ visibility_group_id: null });

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

describeWithSeed('inline fan-out lab benchmark', [withWaves([wave])], () => {
  let redis: StartedTestContainer;
  let gateway: http.Server;
  let inFlight = 0;
  let maxInFlight = 0;
  let received = 0;

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7.4.5-alpine')
      .withExposedPorts(6379)
      .start();
    mockRedis = createClient({
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`
    });
    await mockRedis.connect();
    gateway = http.createServer((request, response) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      request.resume();
      request.on('end', () =>
        setTimeout(() => {
          inFlight--;
          received++;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        }, GATEWAY_MS)
      );
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    process.env.NODE_ENV = 'production';
    process.env.API_GATEWAY_WS_ENDPOINT = `http://127.0.0.1:${address.port}`;
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'bench';
    process.env.AWS_SECRET_ACCESS_KEY = 'bench';
  }, 120_000);

  afterAll(async () => {
    await mockRedis?.quit();
    await redis?.stop();
    await new Promise((resolve) => gateway.close(resolve));
  });

  it(`fans one chat drop out to ${RECIPIENTS} sockets`, async () => {
    const rows = Array.from(
      { length: RECIPIENTS },
      (_, index) => `('bench-${index}', 4102444800, 'profile-${index % 400}')`
    );
    for (let offset = 0; offset < rows.length; offset += 500) {
      await sqlExecutor.execute(
        `insert into ${WS_CONNECTIONS_TABLE} (connection_id, jwt_expiry, identity_id) values ${rows
          .slice(offset, offset + 500)
          .join(',')}`
      );
    }
    // Imported after the environment selects the gateway transport.
    const { WsConnectionRepository } =
      await import('@/api/ws/ws-connection.repository');
    const { UserGroupsService } =
      await import('@/api/community-members/user-groups.service');
    const { UserGroupsDb } = await import('@/user-groups/user-groups.db');
    const { AppWebSockets } = await import('@/api/ws/ws');
    const { WsListenersNotifier } =
      await import('@/api/ws/ws-listeners-notifier');
    const { competitionAnonymityService } =
      await import('@/competitions/competition-anonymity');
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
    const repo = new WsConnectionRepository(
      () => sqlExecutor,
      new UserGroupsService(
        new UserGroupsDb(() => sqlExecutor),
        mock(),
        mock()
      ),
      () => false
    );
    const reads = jest.spyOn(repo, 'getByConnectionId');
    const notifier = new WsListenersNotifier(new AppWebSockets(repo), repo, {
      getViewerContextsForDrop: async () => ({})
    });
    const drop = {
      id: 'bench-drop',
      serial_no: 1,
      drop_type: 'CHAT',
      author: { id: 'profile-author', subscribed_actions: [] },
      wave: { id: wave.id, visibility_group_id: null },
      moderation: { status: 'VISIBLE', can_view: true },
      viewer_context: { author_blocked: false, drop_hidden: false },
      parts: [{ part_id: 1, content: 'x'.repeat(400), media: [] }],
      reactions: []
    } as never;

    const totals: number[] = [];
    for (let run = 0; run < RUNS + 1; run++) {
      await mockRedis.flushDb();
      received = 0;
      maxInFlight = 0;
      reads.mockClear();
      const startedAt = performance.now();
      await notifier.notifyAboutDropUpdate(drop, {});
      const total = performance.now() - startedAt;
      expect(received).toBe(RECIPIENTS);
      if (run > 0) totals.push(total); // run 0 warms connections and JIT
    }
    process.stdout.write(
      `${JSON.stringify({
        bench: 'inline-fanout',
        recipients: RECIPIENTS,
        gateway_ms: GATEWAY_MS,
        runs: RUNS,
        fanout_ms_p50: Math.round(percentile(totals, 50)),
        fanout_ms_max: Math.round(Math.max(...totals)),
        connection_reads_per_fanout: reads.mock.calls.length,
        max_concurrent_gateway_requests: maxInFlight
      })}\n`
    );

    // Waves 1.1: reply after commit with an in-memory queue.
    const sqsMs = Number(process.env.BENCH_SQS_MS ?? 15);
    const queued: any[] = [];
    const asyncNotifier = new WsListenersNotifier(
      new AppWebSockets(repo),
      repo,
      { getViewerContextsForDrop: async () => ({}) },
      undefined,
      {
        enqueue: async (jobs) => {
          await new Promise((resolve) => setTimeout(resolve, sqsMs));
          queued.push(...jobs);
          return [];
        }
      }
    );
    process.env.WS_ASYNC_FANOUT = 'true';
    const requestShares: number[] = [];
    const chunkTimes: number[] = [];
    try {
      for (let run = 0; run < RUNS + 1; run++) {
        await mockRedis.flushDb();
        queued.length = 0;
        received = 0;
        const startedAt = performance.now();
        await asyncNotifier.notifyAboutDropUpdate(drop, {});
        const share = performance.now() - startedAt;
        const inlineReceived = received;
        for (const job of queued) {
          const chunkStartedAt = performance.now();
          await asyncNotifier.deliverQueuedDropFrames(job);
          if (run > 0) chunkTimes.push(performance.now() - chunkStartedAt);
        }
        expect(received).toBe(RECIPIENTS);
        expect(inlineReceived).toBeLessThan(RECIPIENTS);
        if (run > 0) requestShares.push(share);
      }
    } finally {
      delete process.env.WS_ASYNC_FANOUT;
    }
    process.stdout.write(
      `${JSON.stringify({
        bench: 'reply-after-commit',
        recipients: RECIPIENTS,
        gateway_ms: GATEWAY_MS,
        sqs_hand_off_ms: sqsMs,
        runs: RUNS,
        request_share_ms_p50: Math.round(percentile(requestShares, 50)),
        request_share_ms_max: Math.round(Math.max(...requestShares)),
        chunks_per_drop: queued.length,
        chunk_ms_p50: Math.round(percentile(chunkTimes, 50)),
        chunk_ms_max: Math.round(Math.max(...chunkTimes))
      })}\n`
    );
  }, 600_000);
});
