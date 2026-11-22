import {
  decodeE2eeRecordContent,
  E2eeExternalBytes,
  e2eeSha256
} from '@/e2ee/relay/e2ee-record-container';
import {
  checkE2eeRecord,
  E2eeRecordKind,
  E2eeSignedRecordEvent
} from '@/e2ee/relay/e2ee-record-event';
import {
  E2eeRelayMode,
  E2eeRelaySettings
} from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  E2eeRecordAppend,
  E2eeRelayQuorumError,
  E2eeStreamPublisher,
  relayHeadAnchorSource
} from '@/e2ee/relay/e2ee-stream-publisher';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import {
  e2eeTestRelayIdentity,
  InMemoryE2eeStreamStore
} from '@/tests/fixtures/e2ee-stream-store.fixture';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const GROUP = `0x${'01'.repeat(32)}`;
const DEVICE = `0x${'02'.repeat(32)}`;

function setup(input: {
  mode: E2eeRelayMode;
  relays?: number;
  quorum?: number;
}) {
  const relays = Array.from(
    { length: input.relays ?? 2 },
    (_, index) =>
      new MockCrpRelay({
        url: `wss://relay-${index}.test`,
        net: NET,
        head: 5000,
        roles: { [ORDERER.grant.wallet]: ['orderer'] }
      })
  );
  const byUrl = new Map(relays.map((relay) => [relay.options.url, relay]));
  const settings: E2eeRelaySettings = {
    mode: input.mode,
    urls: relays.map((relay) => relay.options.url),
    net: NET,
    quorum: input.quorum ?? 1,
    orderer: ORDERER,
    siteReader: null
  };
  const pool = new E2eeRelayPool({
    urls: settings.urls,
    net: NET,
    identity: ORDERER,
    open: (url) => byUrl.get(url)!.connect(),
    timeoutMs: 1000
  });
  let clock = 1_795_000_000_000;
  const store = new InMemoryE2eeStreamStore();
  const publisher = new E2eeStreamPublisher({
    settings: () => settings,
    store,
    pool: () => pool,
    anchors: relayHeadAnchorSource(() => pool),
    now: () => clock++
  });
  return { relays, store, publisher, pool, settings };
}

function welcome(n: number): E2eeRecordAppend {
  return {
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
          welcome_id: `0x${n}`,
          device_key: DEVICE,
          profile_id: 'p',
          created_at: n
        }
      }
    ]
  };
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
        table: 'e2ee_log',
        row: { group_handle: GROUP, seq, data: new E2eeExternalBytes(bytes) }
      }
    ],
    log: { epoch: 3, windows: [{ d: DEVICE, from: 0, to: null }] }
  };
}

function contentOf(relay: MockCrpRelay, event: E2eeSignedRecordEvent) {
  const body = JSON.parse(event.body!);
  const ref = event.kind === E2eeRecordKind.LOG ? body.ds : (body.c ?? body);
  const bytes =
    typeof ref === 'string'
      ? Buffer.from(ref, 'base64url')
      : (relay as unknown as { payloads: Map<string, Buffer> }).payloads.get(
          ref.h
        )!;
  return { bytes, content: decodeE2eeRecordContent(bytes) };
}

describe('E2eeStreamPublisher', () => {
  afterEach(() => jest.useRealTimers());

  it('records nothing while the mode is off', async () => {
    const { publisher, store, relays } = setup({ mode: 'off' });
    expect(publisher.batch()).toBeNull();
    const result = await publisher.run(store, async (_connection, batch) => {
      expect(batch).toBeNull();
      return 'written';
    });
    expect(result).toBe('written');
    expect(store.outboxRows).toEqual([]);
    expect(relays[0].stored).toEqual([]);
  });

  it('mirror: publishes after the commit, hash-chained, to every relay', async () => {
    const { publisher, store, relays } = setup({ mode: 'mirror' });
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, welcome(1));
      await batch!.append(connection, welcome(2));
    });
    expect(store.outboxRows).toEqual([]);
    for (const relay of relays) {
      expect(relay.stored).toHaveLength(2);
      const [first, second] = relay.stored.map((item) =>
        contentOf(relay, item.event)
      );
      expect(first.content).toMatchObject({
        pos: 1,
        prev: null,
        type: 'welcome'
      });
      expect(second.content).toMatchObject({
        pos: 2,
        prev: e2eeSha256(first.bytes)
      });
      for (const item of relay.stored) {
        expect(checkE2eeRecord(item.event, ORDERER.deviceKey)).toEqual({
          ok: true
        });
        expect(item.event.anchor).toBe(5000);
      }
    }
    expect(relays[0].stored.map((item) => item.event.id)).toEqual(
      relays[1].stored.map((item) => item.event.id)
    );
    expect(store.head(`dv/${DEVICE}`)?.pos).toBe(2);
  });

  it('puts an item ciphertext as its own payload and keeps the LOG body small', async () => {
    const { publisher, store, relays } = setup({ mode: 'mirror', relays: 1 });
    const ciphertext = Buffer.alloc(70_000, 7);
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, message(1, ciphertext));
    });
    const [stored] = relays[0].stored;
    const body = JSON.parse(stored.event.body!);
    expect(body).toMatchObject({
      seq: 1,
      epoch: 3,
      item: 'message',
      windows: [{ d: DEVICE, from: 0, to: null }],
      data: { h: e2eeSha256(ciphertext), n: 70_000 }
    });
    expect(typeof body.ds).toBe('string');
    expect(relays[0].hasPayload(e2eeSha256(ciphertext))).toBe(true);
    expect(stored.event.body!.length).toBeLessThan(2048);
  });

  it('mirror: a relay outage never fails the write; the loop catches up in order', async () => {
    const { publisher, store, relays } = setup({ mode: 'mirror' });
    relays[1].down = true;
    for (const n of [1, 2, 3]) {
      await publisher.run(store, async (connection, batch) => {
        await batch!.append(connection, welcome(n));
      });
    }
    expect(relays[0].stored).toHaveLength(3);
    expect(relays[1].stored).toHaveLength(0);
    expect(store.outboxRows.map((row) => row.heldBy)).toEqual([
      ['wss://relay-0.test'],
      ['wss://relay-0.test'],
      ['wss://relay-0.test']
    ]);
    relays[1].down = false;
    const pass = await publisher.publishPending(10);
    expect(pass).toEqual({ waves: 1, complete: 1 });
    expect(store.outboxRows).toEqual([]);
    expect(relays[1].stored.map((item) => item.event.id)).toEqual(
      relays[0].stored.map((item) => item.event.id)
    );
  });

  it('primary: with no relay to confirm, the write rolls back', async () => {
    const { publisher, store, relays } = setup({ mode: 'primary' });
    relays.forEach((relay) => (relay.down = true));
    await expect(
      publisher.run(store, async (connection, batch) => {
        await batch!.append(connection, welcome(1));
      })
    ).rejects.toBeInstanceOf(E2eeRelayQuorumError);
    expect(store.outboxRows).toEqual([]);
    expect(store.head(`dv/${DEVICE}`)).toBeNull();
  });

  it('primary: commits once the quorum holds the record, the rest follow', async () => {
    const { publisher, store, relays } = setup({ mode: 'primary', quorum: 1 });
    relays[1].down = true;
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, welcome(1));
    });
    expect(relays[0].stored).toHaveLength(1);
    expect(store.outboxRows).toHaveLength(1);
    relays[1].down = false;
    await publisher.publishPending(10);
    expect(relays[1].stored).toHaveLength(1);
    expect(store.outboxRows).toEqual([]);
  });

  it('primary: a quorum of two refuses a write that only one relay holds', async () => {
    const { publisher, store, relays } = setup({ mode: 'primary', quorum: 2 });
    relays[1].down = true;
    await expect(
      publisher.run(store, async (connection, batch) => {
        await batch!.append(connection, welcome(1));
      })
    ).rejects.toThrow('reached 1 of 2 relays');
    expect(store.outboxRows).toEqual([]);
  });

  it('resumes a refused sequence at the refused record, keeping order', async () => {
    const { publisher, store, relays } = setup({ mode: 'mirror', relays: 1 });
    relays[0].refuseNextPubs = 1;
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, welcome(1));
      await batch!.append(connection, welcome(2));
    });
    expect(relays[0].stored).toHaveLength(0);
    expect(store.outboxRows.map((row) => row.attempts)).toEqual([1, 1]);
    await publisher.publishPending(10);
    const positions = relays[0].stored.map(
      (item) => contentOf(relays[0], item.event).content.pos
    );
    expect(positions).toEqual([1, 2]);
  });

  it('signs a record once, so every relay gets the same event id', async () => {
    const { publisher, store, relays } = setup({ mode: 'mirror' });
    relays[1].down = true;
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, welcome(1));
    });
    const signedEvent = store.outboxRows[0].event;
    relays[1].down = false;
    await publisher.publishPending(10);
    expect(JSON.parse(signedEvent!).id).toBe(relays[1].stored[0].event.id);
    expect(relays[0].stored[0].event.id).toBe(relays[1].stored[0].event.id);
  });

  it('does not sign without an anchor from the relays', async () => {
    const { store, settings } = setup({ mode: 'mirror' });
    const publisher = new E2eeStreamPublisher({
      settings: () => settings,
      store,
      pool: () => {
        throw new Error('no pool');
      },
      anchors: {
        anchor: () => Promise.reject(new Error('no anchor'))
      },
      now: () => 1
    });
    await publisher.run(store, async (connection, batch) => {
      await batch!.append(connection, welcome(1));
    });
    expect(store.outboxRows).toHaveLength(1);
    expect(store.outboxRows[0].event).toBeNull();
  });
});
