import { E2EE_LOG_TABLE } from '@/constants/db-tables';
import { E2eeExternalBytes } from '@/e2ee/relay/e2ee-record-container';
import { E2eeRecordKind } from '@/e2ee/relay/e2ee-record-event';
import { E2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  e2eeEventContentHash,
  e2eeRelayLagMetrics,
  E2eeRelayLoopReport,
  emitE2eeRelayLagMetrics,
  runE2eeRelayPublishLoop
} from '@/e2ee/relay/e2ee-relay-publish-loop';
import {
  E2eeRecordAppend,
  E2eeStreamPublisher,
  relayHeadAnchorSource
} from '@/e2ee/relay/e2ee-stream-publisher';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import {
  e2eeTestModerationKey,
  e2eeTestRelayIdentity,
  InMemoryE2eeStreamStore
} from '@/tests/fixtures/e2ee-stream-store.fixture';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const GROUP = `0x${'01'.repeat(32)}`;
const DEVICE = `0x${'02'.repeat(32)}`;
const T0 = 1_795_000_000_000;

function setup() {
  const relays = [0, 1].map(
    (index) =>
      new MockCrpRelay({
        url: `wss://relay-${index}.test`,
        net: NET,
        head: 5000,
        roles: { [ORDERER.grant.wallet]: ['orderer'] }
      })
  );
  const byUrl = new Map(relays.map((relay) => [relay.options.url, relay]));
  /** Connections wait while a relay is held (a relay that does not answer). */
  const held = new Set<string>();
  const settings: E2eeRelaySettings = {
    mode: 'mirror',
    urls: relays.map((relay) => relay.options.url),
    net: NET,
    quorum: 1,
    orderer: ORDERER,
    ordererPublicKey: ORDERER.deviceKey,
    siteReader: null,
    moderation: e2eeTestModerationKey(0x31).recipient,
    moderationKeys: []
  };
  let clock = T0;
  const pool = new E2eeRelayPool({
    urls: settings.urls,
    net: NET,
    identity: ORDERER,
    open: async (url) => {
      while (held.has(url)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return byUrl.get(url)!.connect();
    },
    timeoutMs: 1000,
    now: () => clock
  });
  const store = new InMemoryE2eeStreamStore();
  const publisher = new E2eeStreamPublisher({
    settings: () => settings,
    store,
    pool: () => pool,
    anchors: relayHeadAnchorSource(() => pool),
    now: () => clock++,
    random: () => 1
  });
  const metrics: E2eeRelayLoopReport[] = [];
  const loop = () =>
    runE2eeRelayPublishLoop({
      settings: () => settings,
      publisher,
      store,
      pool: () => pool,
      now: () => clock,
      metrics: (report) => metrics.push(report)
    });
  const wait = (ms: number) => (clock += ms);
  return { relays, held, store, publisher, loop, settings, metrics, wait };
}

function message(seq: number, bytes: Buffer): E2eeRecordAppend {
  return {
    family: 'cv',
    owner: GROUP,
    kind: E2eeRecordKind.LOG,
    refs: ['message'],
    type: 'message',
    ops: [
      {
        op: 'put',
        table: E2EE_LOG_TABLE,
        row: { group_handle: GROUP, seq, data: new E2eeExternalBytes(bytes) }
      }
    ],
    log: { epoch: 1, windows: [{ d: DEVICE, from: 0, to: null }] }
  };
}

describe('mirror publishing and the publisher loop', () => {
  it('answers the write before any relay does; the loop publishes the rest', async () => {
    const { relays, held, store, publisher, loop } = setup();
    held.add(relays[0].options.url);
    held.add(relays[1].options.url);
    await publisher.run(store, (connection, batch) =>
      batch!.append(connection, message(1, Buffer.alloc(100, 1)))
    );
    // The write returned while both relays were still silent.
    expect(store.outboxRows).toHaveLength(1);
    expect(relays[0].stored).toEqual([]);
    held.clear();
    await publisher.settled();
    const report = await loop();
    expect(report.outbox.rows).toBe(0);
    expect(relays.map((relay) => relay.stored.length)).toEqual([1, 1]);
  });

  it('pages a backlog by bytes, so large records never load at once', async () => {
    const { relays, store, publisher } = setup();
    relays[1].down = true;
    for (const seq of [1, 2, 3, 4]) {
      await publisher.run(store, (connection, batch) =>
        batch!.append(connection, message(seq, Buffer.alloc(3 << 20, seq)))
      );
    }
    await publisher.settled();
    // 12 MiB waits: no page may exceed 8 MiB, yet every row is listed.
    const first = await store.listOutbox(`cv/${GROUP}`, 200);
    expect(first.map((row) => row.pos)).toEqual([1, 2]);
    relays[1].down = false;
    await publisher.publishPending(10);
    expect(store.outboxRows).toEqual([]);
    expect(relays[1].stored.map((item) => item.rseq)).toEqual([1, 2, 3, 4]);
  });

  it('finds a relay that lost a stream head and copies what it misses', async () => {
    const { relays, store, publisher, loop } = setup();
    for (const seq of [1, 2, 3]) {
      await publisher.run(store, (connection, batch) =>
        batch!.append(connection, message(seq, Buffer.alloc(64, seq)))
      );
    }
    await publisher.settled();
    expect(store.outboxRows).toEqual([]);
    relays[1].forgetNewest(2);
    const report = await loop();
    expect(report.heads).toMatchObject({
      checked: 1,
      behind: [`cv/${GROUP}@${relays[1].options.url}`],
      repaired: 1,
      unrepaired: []
    });
    expect(relays[1].stored.map((item) => item.event.id)).toEqual(
      relays[0].stored.map((item) => item.event.id)
    );
    const head = store.head(`cv/${GROUP}`)!;
    expect(e2eeEventContentHash(relays[1].stored[2].event)).toBe(head.hash);
    expect((await loop()).heads.behind).toEqual([]);
  });

  it('does nothing while records are off', async () => {
    const { settings, loop, relays } = setup();
    Object.assign(settings, { mode: 'off' });
    expect((await loop()).heads.checked).toBe(0);
    expect(relays[0].seen['HELLO']).toBeUndefined();
  });

  it('runs one publish per stream at a time', async () => {
    const { relays, store, publisher } = setup();
    relays[0].down = true;
    relays[1].down = true;
    for (const seq of [1, 2, 3]) {
      await publisher.run(store, (connection, batch) =>
        batch!.append(connection, message(seq, Buffer.alloc(64, seq)))
      );
    }
    await publisher.settled();
    relays[0].down = false;
    relays[1].down = false;
    let active = 0;
    let most = 0;
    const listOutbox = store.listOutbox.bind(store);
    store.listOutbox = async (...args) => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await listOutbox(...args);
      } finally {
        active--;
      }
    };
    await Promise.all([
      publisher.publishWave(`cv/${GROUP}`),
      publisher.publishWave(`cv/${GROUP}`),
      publisher.publishWave(`cv/${GROUP}`)
    ]);
    expect(most).toBe(1);
    expect(store.outboxRows).toEqual([]);
    expect(relays[0].stored).toHaveLength(3);
  });

  it('sends DELs of at most 58 distinct ids in 4 KiB, never in cv', async () => {
    const { relays, store, publisher } = setup();
    for (let n = 0; n < 130; n++) {
      await publisher.run(store, (connection, batch) =>
        batch!.append(connection, {
          family: 'dv',
          owner: DEVICE,
          kind: E2eeRecordKind.SEALED,
          refs: ['welcome'],
          type: 'welcome',
          ops: [
            {
              op: 'put',
              table: 'e2ee_welcome_deliveries',
              row: {
                welcome_id: `0x${n.toString(16).padStart(32, '0')}`,
                device_key: DEVICE,
                profile_id: 'p',
                created_at: n
              }
            }
          ]
        })
      );
    }
    await publisher.settled();
    await publisher.publishPending(10);
    expect(await publisher.queueDeletion('cv', GROUP, ['message:*'])).toBe(0);
    expect(await publisher.queueDeletion('dv', DEVICE, ['welcome:*'])).toBe(
      130
    );
    expect(store.deletionRows.map((row) => row.positions.length)).toEqual([
      58, 58, 14
    ]);
    expect(await publisher.publishDeletions(10)).toEqual({
      queued: 3,
      done: 3
    });
    for (const relay of relays) {
      const dels = relay.stored.filter((item) => item.event.kind === 12);
      expect(dels).toHaveLength(3);
      for (const del of dels) {
        expect(del.event.refs).toEqual([]);
        expect(Buffer.byteLength(del.event.body!)).toBeLessThanOrEqual(4096);
        const ids = JSON.parse(del.event.body!).ids as string[];
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
    expect(store.itemRows).toEqual([]);
  });

  it('reports the lag as metrics, with the last error of what keeps failing', async () => {
    const { relays, store, publisher, loop, metrics, wait } = setup();
    relays[1].down = true;
    await publisher.run(store, (connection, batch) =>
      batch!.append(connection, message(1, Buffer.alloc(64, 1)))
    );
    await publisher.settled();
    wait(20 * 60 * 1000);
    const lagging = await loop();
    expect(lagging.failures.outbox).toEqual({
      wave: `cv/${GROUP}`,
      attempts: expect.any(Number),
      lastError: expect.stringContaining('wss://relay-1.test')
    });
    // The write and this run both tried relay-1.
    expect(lagging.failures.outbox!.attempts).toBeGreaterThanOrEqual(2);
    expect(e2eeRelayLagMetrics(metrics[0])).toEqual({
      OutboxRows: 1,
      OutboxOldestAgeSeconds: 1200,
      OutboxMostAttempts: lagging.failures.outbox!.attempts,
      DeletionsWaiting: 0,
      HeadsBehind: 0,
      HeadsUnrepaired: 0
    });
    relays[1].down = false;
    const drained = await loop();
    expect(drained.failures).toEqual({ outbox: null, deletion: null });
    expect(e2eeRelayLagMetrics(metrics[1])).toMatchObject({
      OutboxRows: 0,
      OutboxOldestAgeSeconds: 0,
      HeadsUnrepaired: 0
    });
  });

  it('writes the metrics in embedded metric format only in a Lambda', () => {
    const report = {
      mode: 'mirror',
      published: { waves: 0, complete: 0 },
      outbox: { rows: 3, oldestAgeMs: 90_500 },
      deletions: { done: 0, waiting: 1 },
      failures: { outbox: null, deletion: null },
      heads: { checked: 0, behind: [], repaired: 0, unrepaired: [] }
    } as const;
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const saved = process.env.AWS_LAMBDA_FUNCTION_NAME;
    try {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      emitE2eeRelayLagMetrics(report);
      expect(write).not.toHaveBeenCalled();
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'e2eeRelayPublishLoop';
      emitE2eeRelayLagMetrics(report);
      const line = JSON.parse(String(write.mock.calls[0][0]));
      expect(line._aws.CloudWatchMetrics[0]).toMatchObject({
        Namespace: '6529/E2eeRelay',
        Dimensions: [['Environment']]
      });
      expect(line).toMatchObject({
        OutboxRows: 3,
        OutboxOldestAgeSeconds: 90,
        DeletionsWaiting: 1
      });
    } finally {
      if (saved === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = saved;
      write.mockRestore();
    }
  });
});
