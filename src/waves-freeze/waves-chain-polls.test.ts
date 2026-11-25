import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import {
  assertPollCreationOpen,
  assertRelayedPollCreationOpen,
  isChainPollCreationPaused,
  POLL_CREATE_OP_TYPE,
  WAVES_POLLS_PAUSED_CODE,
  WAVES_POLLS_PAUSED_MESSAGE,
  WavesPollsPausedException
} from '@/waves-freeze/waves-chain-polls';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_CHAIN_POLLS'
];
const FREEZE = Date.UTC(2026, 10, 27);
const SWITCH_ON = Date.UTC(2026, 10, 28);

const VOTE_SET = 0x0606;
const GROUP_CREATE = 0x0401;

const hexOf = (value: number | bigint, bytes: number) =>
  BigInt(value)
    .toString(16)
    .padStart(bytes * 2, '0');

/** A wallet-signed transaction's unsigned bytes, made-up values. */
function envelope(opType: number): string {
  return (
    '0x' +
    [
      '4001',
      '0001',
      '5a'.repeat(32),
      hexOf(7, 4),
      'a1'.repeat(32),
      hexOf(1, 1),
      '00'.repeat(12) + '1a'.repeat(20),
      '00',
      hexOf(0, 4),
      hexOf(3, 8),
      hexOf(1_800_000_000_000, 8),
      hexOf(1_800_003_600_000, 8),
      '00',
      '03',
      '00',
      hexOf(BigInt('1000000000000000000'), 16),
      hexOf(100_000, 8),
      hexOf(0, 16),
      hexOf(opType, 2),
      '0001',
      'ab'.repeat(87)
    ].join('')
  );
}

/** The same transaction signed: one wallet signature, empty proof. */
function signed(unsigned: string): string {
  return (
    unsigned +
    hexOf(1, 4) +
    hexOf(0, 1) +
    hexOf(1, 1) +
    hexOf(65, 4) +
    '1b'.repeat(65) +
    hexOf(0, 4)
  );
}

const ctx = {};

describe('new polls in moved waves from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    // Every wave moves unless a test says otherwise.
    stubWavesScope({ staying: ['staying-wave'] });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  describe('isChainPollCreationPaused', () => {
    it('pauses from the switch-on time until the setting is on', () => {
      expect(isChainPollCreationPaused(SWITCH_ON - 1)).toBe(false);
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(true);
      process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(false);
    });

    it('pauses with FEATURE_WAVES_ON_CHAIN and no switch-on time', () => {
      delete process.env.WAVES_SWITCH_ON_AT;
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(false);
      process.env.FEATURE_WAVES_ON_CHAIN = 'true';
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(true);
    });

    it('takes only the exact word true for the setting', () => {
      process.env.FEATURE_WAVES_CHAIN_POLLS = 'TRUE';
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(true);
      process.env.FEATURE_WAVES_CHAIN_POLLS = '1';
      expect(isChainPollCreationPaused(SWITCH_ON)).toBe(true);
    });
  });

  describe('assertPollCreationOpen (6529.io API)', () => {
    it('refuses in a moved wave after the switch-on with the setting off', async () => {
      const error = await assertPollCreationOpen('moved-wave', ctx).catch(
        (e) => e
      );
      expect(error).toBeInstanceOf(WavesPollsPausedException);
      expect(error.getStatusCode()).toBe(423);
      expect(error.code).toBe(WAVES_POLLS_PAUSED_CODE);
      expect(error.message).toBe(WAVES_POLLS_PAUSED_MESSAGE);
    });

    it('allows a moved wave with the setting on (the freeze decides alone)', async () => {
      process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
      delete process.env.WAVES_FREEZE_AT;
      await expect(
        assertPollCreationOpen('moved-wave', ctx)
      ).resolves.toBeUndefined();
      // With the freeze on, the freeze's own refusal stays.
      process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
      await expect(
        assertPollCreationOpen('moved-wave', ctx)
      ).rejects.toBeInstanceOf(WavesFrozenException);
    });

    it('allows a staying wave after the switch-on, frozen or not', async () => {
      await expect(
        assertPollCreationOpen('staying-wave', ctx)
      ).resolves.toBeUndefined();
      delete process.env.WAVES_FREEZE_AT;
      await expect(
        assertPollCreationOpen('staying-wave', ctx)
      ).resolves.toBeUndefined();
    });

    it('allows a moving wave before the switch-on and the freeze', async () => {
      now.mockReturnValue(FREEZE - 1);
      await expect(
        assertPollCreationOpen('moved-wave', ctx)
      ).resolves.toBeUndefined();
    });

    it('leaves the freeze its own refusal between the freeze and the switch-on', async () => {
      now.mockReturnValue(FREEZE + 1);
      await expect(
        assertPollCreationOpen('moved-wave', ctx)
      ).rejects.toBeInstanceOf(WavesFrozenException);
    });

    it("reads the wave's side once, and not at all when nothing holds polls", async () => {
      const scope = stubWavesScope();
      await expect(
        assertPollCreationOpen('moved-wave', ctx)
      ).rejects.toBeInstanceOf(WavesPollsPausedException);
      expect(scope.waveStays).toHaveBeenCalledTimes(1);
      expect(scope.waveStays).toHaveBeenCalledWith('moved-wave', ctx);
      scope.waveStays.mockClear();
      now.mockReturnValue(FREEZE - 1);
      await assertPollCreationOpen('moved-wave', ctx);
      expect(scope.waveStays).not.toHaveBeenCalled();
    });
  });

  describe('assertRelayedPollCreationOpen (the operation relay)', () => {
    const poll = envelope(POLL_CREATE_OP_TYPE);

    it('refuses a POLL_CREATE after the switch-on with the setting off, in either form', () => {
      expect(() => assertRelayedPollCreationOpen(poll)).toThrow(
        WavesPollsPausedException
      );
      expect(() => assertRelayedPollCreationOpen(signed(poll))).toThrow(
        WavesPollsPausedException
      );
      expect(() =>
        assertRelayedPollCreationOpen(poll.toUpperCase().replace('0X', '0x'))
      ).toThrow(WavesPollsPausedException);
    });

    it('relays a POLL_CREATE with the setting on', () => {
      process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
      expect(() => assertRelayedPollCreationOpen(poll)).not.toThrow();
    });

    it('relays a POLL_CREATE before the switch-on (the chain decides)', () => {
      now.mockReturnValue(SWITCH_ON - 1);
      expect(() => assertRelayedPollCreationOpen(poll)).not.toThrow();
    });

    it('relays every other operation, and bytes that are no transaction', () => {
      for (const opType of [VOTE_SET, GROUP_CREATE, 0x0608, 0x0706]) {
        expect(() =>
          assertRelayedPollCreationOpen(envelope(opType))
        ).not.toThrow();
      }
      for (const bytes of ['0x', '0x01', '0xzz', poll.slice(0, 100)]) {
        expect(() => assertRelayedPollCreationOpen(bytes)).not.toThrow();
      }
    });
  });
});
