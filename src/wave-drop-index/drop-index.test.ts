import { createPublicKey, verify } from 'node:crypto';
import {
  TEST_DEVICE_KEY,
  TEST_DEVICE_SEED,
  TEST_GRANT_ID,
  testGrantProof,
  testSignedEvent
} from '@/tests/fixtures/relay-events.fixture';
import {
  DEFAULT_LIVE_FROM,
  DropIndexConfigError,
  dropIndexConfig,
  onDropIndexStored,
  readerAuthAnswer,
  relayAuthDigest
} from './drop-index';
import { RelayWaveReader } from './relay-wave-reader';

const ON = {
  FEATURE_WAVES_DROP_INDEX: 'true',
  WAVES_RELAY_URLS: 'wss://a.example, wss://b.example,wss://a.example',
  WAVES_RELAY_NET: 'net-1'
};

describe('dropIndexConfig', () => {
  it('is off unless the flag is on', () => {
    expect(dropIndexConfig({})).toBeNull();
    expect(
      dropIndexConfig({ ...ON, FEATURE_WAVES_DROP_INDEX: '1' })
    ).toBeNull();
  });

  it('reads the relays, the network, the budget and the reader', () => {
    expect(dropIndexConfig(ON)).toEqual({
      relays: ['wss://a.example', 'wss://b.example'],
      net: 'net-1',
      reader: null,
      budgetMs: 25_000,
      apply: false,
      liveFrom: Date.parse('2026-11-27T00:00:00Z')
    });
    const reader = JSON.stringify({
      device_seed: TEST_DEVICE_SEED,
      grant: testGrantProof()
    });
    expect(
      dropIndexConfig({
        ...ON,
        WAVES_DROP_INDEX_BUDGET_MS: '9000',
        WAVES_DROP_INDEX_READER: reader
      })
    ).toMatchObject({
      budgetMs: 9000,
      reader: { deviceSeed: TEST_DEVICE_SEED }
    });
  });

  it('reads switch-on as ISO 8601 UTC or Unix ms', () => {
    expect(DEFAULT_LIVE_FROM).toBe(Date.parse('2026-11-27T00:00:00Z'));
    for (const [raw, at] of [
      ['2026-11-27T12:30:00Z', Date.parse('2026-11-27T12:30:00Z')],
      ['2026-11-27T12:30:00.250+00:00', Date.parse('2026-11-27T12:30:00.250Z')],
      [' 1795000000000 ', 1795000000000],
      ['', DEFAULT_LIVE_FROM]
    ] as const) {
      expect(
        dropIndexConfig({ ...ON, WAVES_DROP_INDEX_LIVE_FROM: raw })?.liveFrom
      ).toBe(at);
    }
    // Seconds, a local time, a word: not run on a guess.
    for (const raw of ['1795000000', '2026-11-26T00:00:00', 'now', '0']) {
      expect(() =>
        dropIndexConfig({ ...ON, WAVES_DROP_INDEX_LIVE_FROM: raw })
      ).toThrow('WAVES_DROP_INDEX_LIVE_FROM');
    }
  });

  it('refuses settings it cannot use', () => {
    expect(() => dropIndexConfig({ ...ON, WAVES_RELAY_URLS: '' })).toThrow(
      DropIndexConfigError
    );
    expect(() =>
      dropIndexConfig({ ...ON, WAVES_RELAY_URLS: 'https://a.example' })
    ).toThrow('is not a ws:// or wss:// address');
    expect(() => dropIndexConfig({ ...ON, WAVES_RELAY_NET: ' ' })).toThrow(
      'WAVES_RELAY_NET is not set'
    );
    expect(() =>
      dropIndexConfig({ ...ON, WAVES_DROP_INDEX_READER: '{"device_seed":"x"}' })
    ).toThrow('needs device_seed');
  });
});

describe('the site reader AUTH', () => {
  it('signs the relay auth digest of wave-relay auth.rs', () => {
    // The vector from the validator's wave-relay auth tests.
    expect(
      relayAuthDigest(
        '6529-test',
        'relay-a',
        `0x${'07'.repeat(32)}`,
        '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc'
      )
    ).toBe(
      '0x3912b1d0e927030d0d9d0ed60d8f8427daabd18b3e4747c4bcf5ea487712b846'
    );
  });

  it("answers with the grant and the device key's signature over the digest", () => {
    const grant = testGrantProof();
    const answer = readerAuthAnswer({ deviceSeed: TEST_DEVICE_SEED, grant })(
      { nonce: `0x${'07'.repeat(32)}`, expires: 0 },
      { relayId: 'relay-a', net: 'net-1', logEpoch: 1 }
    );
    expect(answer.grant).toBe(grant);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(TEST_DEVICE_KEY.slice(2), 'hex')
      ]),
      format: 'der',
      type: 'spki'
    });
    const digest = relayAuthDigest(
      'net-1',
      'relay-a',
      `0x${'07'.repeat(32)}`,
      TEST_GRANT_ID
    );
    expect(
      verify(
        null,
        Buffer.from(digest.slice(2), 'hex'),
        publicKey,
        Buffer.from(answer.sig.slice(2), 'hex')
      )
    ).toBe(true);
  });

  it("refuses a seed that is not the grant's device key", () => {
    expect(() =>
      readerAuthAnswer({
        deviceSeed: `0x${'01'.repeat(32)}`,
        grant: testGrantProof()
      })
    ).toThrow("not the grant's device key");
  });
});

describe('onDropIndexStored', () => {
  it('adds and removes a listener', () => {
    const stop = onDropIndexStored(() => undefined);
    expect(typeof stop).toBe('function');
    stop();
    stop();
  });
});

describe('RelayWaveReader', () => {
  it("reads a wave's checked events oldest first, page after page", async () => {
    const events = [1, 2, 3].map((seq) => testSignedEvent({ seq }));
    const items = events.map((event, i) => ({
      rseq: i + 1,
      event,
      grant: testGrantProof()
    }));
    items[1] = { ...items[1], event: { ...items[1].event, seq: 9 } };
    const asked: (number | null)[] = [];
    let closed = false;
    const rejected: unknown[] = [];
    const reader = new RelayWaveReader(
      async () => ({
        async history(_wave: string, after: number | null, limit: number) {
          asked.push(after);
          const rest = items.filter((item) => item.rseq > (after ?? 0));
          return {
            logEpoch: 3,
            items: rest.slice(0, limit),
            more: rest.length > limit
          };
        },
        close() {
          closed = true;
        }
      }),
      (rseq, reason) => rejected.push([rseq, reason]),
      2
    );
    const read: number[] = [];
    for await (const event of reader.read('wave-1')) read.push(event.rseq);
    expect(read).toEqual([1, 3]);
    expect(asked).toEqual([0, 2]);
    expect(rejected).toEqual([[2, 'event id does not match']]);
    expect(closed).toBe(true);
  });
});
