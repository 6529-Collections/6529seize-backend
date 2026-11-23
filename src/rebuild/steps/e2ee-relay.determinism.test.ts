import { randomBytes, randomUUID } from 'node:crypto';
import {
  E2EE_MODERATION_INBOX,
  openE2eeRecordContent,
  sealE2eeRecordContent
} from '@/e2ee/relay/e2ee-moderation-seal';
import { encodeE2eeRecordContent } from '@/e2ee/relay/e2ee-record-container';
import {
  E2EE_CHECK_T0,
  installDeterministicSeed
} from '@/rebuild/steps/e2ee-relay.determinism';
import {
  e2eeTestModerationKey,
  e2eeTestRelayIdentity
} from '@/tests/fixtures/e2ee-stream-store.fixture';

const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const MODERATION = e2eeTestModerationKey(0x31);
const WAVE = `md/${E2EE_MODERATION_INBOX}`;

/** What one seed run draws, in order. */
function draws() {
  const content = encodeE2eeRecordContent({
    type: 'report',
    pos: 1,
    prev: null,
    ops: [{ op: 'put', table: 'e2ee_reports', row: { id: '0x01' } }]
  }).content;
  return {
    now: Date.now(),
    bytes: randomBytes(40).toString('hex'),
    uuid: randomUUID(),
    random: Math.random(),
    sealed: sealE2eeRecordContent({
      content,
      wave: WAVE,
      from: ORDERER.deviceKey,
      to: MODERATION.recipient
    }).toString('hex')
  };
}

function seeded<T>(label: string, run: () => T): T {
  const seed = installDeterministicSeed(label);
  try {
    return run();
  } finally {
    seed.restore();
  }
}

describe('the e2ee seed: fixed clock and randomness', () => {
  it('gives the same draws, sealed records included, every run', () => {
    const first = seeded('label', draws);
    expect(seeded('label', draws)).toEqual(first);
    expect(first.now).toBe(E2EE_CHECK_T0);
    expect(first.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first.random).toBeGreaterThanOrEqual(0);
    expect(first.random).toBeLessThan(1);
  });

  it('draws differently under another label', () => {
    const first = seeded('label', draws);
    const other = seeded('other label', draws);
    expect(other.bytes).not.toBe(first.bytes);
    expect(other.sealed).not.toBe(first.sealed);
  });

  it('seals records the moderation key still opens', () => {
    const sealed = seeded('label', () =>
      sealE2eeRecordContent({
        content: encodeE2eeRecordContent({
          type: 'report',
          pos: 1,
          prev: null,
          ops: [{ op: 'put', table: 'e2ee_reports', row: { id: '0x01' } }]
        }).content,
        wave: WAVE,
        from: ORDERER.deviceKey,
        to: MODERATION.recipient
      })
    );
    expect(() =>
      openE2eeRecordContent({
        bytes: sealed,
        wave: WAVE,
        keys: MODERATION.keys
      })
    ).not.toThrow();
  });

  it('moves the clock only when told, and only forward', () => {
    const seed = installDeterministicSeed('label', 1_000);
    try {
      expect(Date.now()).toBe(1_000);
      seed.advance(500);
      expect(Date.now()).toBe(1_500);
      expect(seed.now()).toBe(1_500);
      expect(() => seed.advance(-1)).toThrow('only moves forward');
    } finally {
      seed.restore();
    }
  });

  it('puts the real clock and randomness back', () => {
    seeded('label', draws);
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1_000);
    expect(randomBytes(16).equals(randomBytes(16))).toBe(false);
  });
});
