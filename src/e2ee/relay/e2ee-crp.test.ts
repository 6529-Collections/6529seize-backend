import {
  CRP_SESSION_MS,
  CrpConnection,
  CrpError,
  decodeCrpBinaryFrame,
  encodeCrpBinaryFrame
} from '@/e2ee/relay/e2ee-crp';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import { relayHeadAnchorSource } from '@/e2ee/relay/e2ee-stream-publisher';
import { e2eeSha256 } from '@/e2ee/relay/e2ee-record-container';
import {
  e2eeEd25519Sign,
  e2eeFamilyWave,
  E2eeRecordKind,
  signE2eeRecord
} from '@/e2ee/relay/e2ee-record-event';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import { e2eeTestRelayIdentity } from '@/tests/fixtures/e2ee-stream-store.fixture';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const READER = e2eeTestRelayIdentity(9, `0x${'bb'.repeat(20)}`);
const STRANGER = e2eeTestRelayIdentity(11, `0x${'cc'.repeat(20)}`);

function relay() {
  return new MockCrpRelay({
    url: 'wss://relay.test',
    net: NET,
    head: 777,
    roles: {
      [ORDERER.grant.wallet]: ['orderer'],
      [READER.grant.wallet]: ['site-reader']
    }
  });
}

async function connect(mock: MockCrpRelay, identity = ORDERER) {
  const connection = new CrpConnection(await mock.connect(), 1000);
  const welcome = await connection.hello(NET);
  const authed = await connection.auth({
    grant: identity.grant,
    sign: (digest) => e2eeEd25519Sign(identity.seed, digest),
    net: NET
  });
  return { connection, welcome, authed };
}

/** Lets the in-process relay's queued frames arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function record(seq: number) {
  return signE2eeRecord({
    draft: {
      kind: E2eeRecordKind.LOG,
      wave: e2eeFamilyWave('cv', `0x${'01'.repeat(32)}`),
      refs: ['message'],
      body: { seq, ds: 'AQ', data: null }
    },
    seed: ORDERER.seed,
    grant: ORDERER.grant,
    seq,
    anchor: 777,
    claimedTime: 1_795_000_000_000 + seq
  });
}

describe('CrpConnection', () => {
  it('frames binary payloads with a length-prefixed JSON header', () => {
    const frame = encodeCrpBinaryFrame(
      { t: 'PAYLOAD', rid: 3 },
      Buffer.from('xyz')
    );
    expect(decodeCrpBinaryFrame(frame)).toEqual({
      header: { t: 'PAYLOAD', rid: 3 },
      bytes: Buffer.from('xyz')
    });
    expect(() => decodeCrpBinaryFrame(Buffer.from([0, 0, 0, 9, 1]))).toThrow(
      CrpError
    );
  });

  it('says HELLO, reads the relay head and authenticates by grant', async () => {
    const { welcome, authed } = await connect(relay());
    expect(welcome).toMatchObject({ net: NET, head: 777 });
    expect(authed).toEqual({
      wallet: ORDERER.grant.wallet,
      principal: null,
      roles: ['orderer']
    });
  });

  it('refuses a HELLO on another network', async () => {
    const connection = new CrpConnection(await relay().connect(), 300);
    await expect(connection.hello('6529-interim-prod')).rejects.toThrow();
  });

  it('publishes, deduplicates and refuses a second record at a taken seq', async () => {
    const mock = relay();
    const { connection } = await connect(mock);
    const first = record(1);
    expect(await connection.publish(first, ORDERER.grant)).toMatchObject({
      status: 'accepted',
      eventId: first.id
    });
    expect((await connection.publish(first, ORDERER.grant)).status).toBe(
      'duplicate'
    );
    const rival = signE2eeRecord({
      draft: {
        kind: E2eeRecordKind.LOG,
        wave: first.wave,
        refs: ['message'],
        body: { seq: 1, ds: 'AA', data: null }
      },
      seed: ORDERER.seed,
      grant: ORDERER.grant,
      seq: 99,
      anchor: 777,
      claimedTime: 1
    });
    expect(await connection.publish(rival, ORDERER.grant)).toMatchObject({
      status: 'rejected',
      reason: 'seq-taken'
    });
  });

  it('uploads and downloads payloads by hash', async () => {
    const mock = relay();
    const { connection } = await connect(mock);
    const bytes = Buffer.alloc(5000, 3);
    const sha = e2eeSha256(bytes);
    expect((await connection.putPayload(sha, bytes)).status).toBe('accepted');
    expect((await connection.putPayload(sha, bytes)).status).toBe('duplicate');
    expect(
      (await connection.putPayload(sha, Buffer.from('other'))).status
    ).toBe('rejected');
    const reader = (await connect(mock, READER)).connection;
    expect(await reader.getPayload(sha)).toEqual(bytes);
    await expect(
      reader.getPayload(e2eeSha256(Buffer.from('none')))
    ).rejects.toThrow('not found');
  });

  it('replays a family to its end and pages a stream', async () => {
    const mock = relay();
    const { connection } = await connect(mock);
    for (const seq of [1, 2, 3]) {
      await connection.publish(record(seq), ORDERER.grant);
    }
    const reader = (await connect(mock, READER)).connection;
    const replay = await reader.replay(['cv']);
    expect(replay.items.map((item) => item.rseq)).toEqual([1, 2, 3]);
    const page = await reader.history(record(1).wave, 1, 1);
    expect(page.items.map((item) => item.rseq)).toEqual([2]);
    expect(page.more).toBe(true);
    const stranger = (await connect(mock, STRANGER)).connection;
    expect((await stranger.replay(['cv'])).items).toEqual([]);
  });

  it('answers the CHALLENGE that comes before its session ends, and only that one', async () => {
    const mock = relay();
    let clock = 1_795_000_000_000;
    const connection = new CrpConnection(
      await mock.connect(),
      1000,
      () => clock
    );
    await connection.hello(NET);
    await connection.auth({
      grant: ORDERER.grant,
      sign: (digest) => e2eeEd25519Sign(ORDERER.seed, digest),
      net: NET
    });
    await settle();
    // The fresh challenge after AUTH comes an hour early: it waits.
    expect(mock.seen['AUTH']).toBe(1);
    expect(connection.sessionEndsAt).toBe(clock + CRP_SESSION_MS);
    clock += 55 * 60_000;
    mock.rechallenge();
    await settle();
    expect(mock.seen['AUTH']).toBe(2);
    expect(connection.sessionEndsAt).toBe(clock + CRP_SESSION_MS);
    await settle();
    expect(mock.seen['AUTH']).toBe(2);
    expect((await connection.publish(record(1), ORDERER.grant)).status).toBe(
      'accepted'
    );
  });

  it('times a replay from its latest frame, not its start', async () => {
    const mock = relay();
    const { connection } = await connect(mock);
    for (const seq of [1, 2, 3, 4, 5, 6]) {
      await connection.publish(record(seq), ORDERER.grant);
    }
    const socket = await mock.connect();
    // Every frame takes 60 ms; the whole replay takes longer than the
    // 150 ms limit, no single gap does.
    const slow = {
      ...socket,
      onMessage: (listener: (data: string | Uint8Array) => void) => {
        let queue = Promise.resolve();
        socket.onMessage((data) => {
          queue = queue.then(
            () =>
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  listener(data);
                  resolve();
                }, 60)
              )
          );
        });
      }
    };
    const reader = new CrpConnection(slow, 150);
    await reader.hello(NET);
    await reader.auth({
      grant: READER.grant,
      sign: (digest) => e2eeEd25519Sign(READER.seed, digest),
      net: NET
    });
    const replay = await reader.replay(['cv']);
    expect(replay.items).toHaveLength(6);
  });

  it('fails pending requests when the relay goes away', async () => {
    const mock = relay();
    const { connection } = await connect(mock);
    mock.down = true;
    await expect(connection.publish(record(1), ORDERER.grant)).rejects.toThrow(
      CrpError
    );
    expect(connection.isOpen).toBe(false);
  });
});

describe('E2eeRelayPool', () => {
  it('anchors at the lowest relay head and reconnects before an hour passes', async () => {
    const low = relay();
    const high = new MockCrpRelay({
      ...low.options,
      url: 'wss://relay-high.test',
      head: 900
    });
    const byUrl = new Map([
      [low.options.url, low],
      [high.options.url, high]
    ]);
    let clock = 1_795_000_000_000;
    const pool = new E2eeRelayPool({
      urls: [low.options.url, high.options.url],
      net: NET,
      identity: ORDERER,
      open: (url) => byUrl.get(url)!.connect(),
      now: () => clock
    });
    await expect(relayHeadAnchorSource(() => pool).anchor()).resolves.toBe(777);
    const first = await pool.connection(low.options.url);
    clock += 10 * 60_000;
    expect(await pool.connection(low.options.url)).toBe(first);
    clock += 25 * 60_000;
    const second = await pool.connection(low.options.url);
    expect(second).not.toBe(first);
    expect(first.isOpen).toBe(false);
    expect(low.seen['HELLO']).toBe(2);
    pool.close();
  });
});
