import { Time } from '@/time';
import {
  movingWaveRefusal,
  WAVES_FROZEN_CODE,
  WAVES_FROZEN_GROUP_MESSAGE,
  WAVES_FROZEN_MESSAGE,
  WAVES_ON_CHAIN_CODE,
  WAVES_ON_CHAIN_MESSAGE,
  WavesFrozenException,
  WavesOnChainException
} from '@/waves-freeze/waves-freeze';
import {
  assertDecisionWritable,
  assertEntriesWritable,
  assertNotMovedOnChain,
  assertWaveCreationOpen,
  assertWaveWritable,
  keepingWaveScope
} from '@/waves-freeze/waves-freeze-scope';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE'
];
const FREEZE = Date.UTC(2026, 10, 27);
const SWITCH_ON = Date.UTC(2026, 10, 28);

const ctx = {};

describe('refusals in a moved wave from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  let scope: ReturnType<typeof stubWavesScope>;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    // Every wave moves unless a test says otherwise.
    scope = stubWavesScope({ staying: ['staying-wave'] });
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

  describe('movingWaveRefusal', () => {
    it('is WAVES_ON_CHAIN from the switch-on: 423, its code, its one message', () => {
      const refusal = movingWaveRefusal(WAVES_FROZEN_GROUP_MESSAGE);
      expect(refusal).toBeInstanceOf(WavesOnChainException);
      expect(refusal.getStatusCode()).toBe(423);
      expect(refusal.code).toBe(WAVES_ON_CHAIN_CODE);
      expect(refusal.message).toBe(WAVES_ON_CHAIN_MESSAGE);
      // The wording the site shows, word for word.
      expect(WAVES_ON_CHAIN_MESSAGE).toBe(
        'This wave moved to the 6529 Network, so this change is made there now, not through this route.'
      );
    });

    it("is the freeze's own refusal, with the message given, before the switch-on", () => {
      const refusal = movingWaveRefusal(
        WAVES_FROZEN_GROUP_MESSAGE,
        SWITCH_ON - 1
      );
      expect(refusal).toBeInstanceOf(WavesFrozenException);
      expect(refusal.getStatusCode()).toBe(423);
      expect(refusal.code).toBe(WAVES_FROZEN_CODE);
      expect(refusal.message).toBe(WAVES_FROZEN_GROUP_MESSAGE);
      expect(movingWaveRefusal(undefined, SWITCH_ON - 1).message).toBe(
        WAVES_FROZEN_MESSAGE
      );
    });

    it('takes the switch-on from FEATURE_WAVES_ON_CHAIN too, as the waves scope does', () => {
      delete process.env.WAVES_SWITCH_ON_AT;
      expect(movingWaveRefusal()).toBeInstanceOf(WavesFrozenException);
      process.env.FEATURE_WAVES_ON_CHAIN = 'true';
      expect(movingWaveRefusal()).toBeInstanceOf(WavesOnChainException);
    });
  });

  describe('the freeze checks', () => {
    it('refuses a moved wave with WAVES_ON_CHAIN, and passes a staying wave', async () => {
      await expect(
        assertWaveWritable('moved-wave', ctx)
      ).rejects.toBeInstanceOf(WavesOnChainException);
      await expect(
        assertDecisionWritable({ wave_id: 'moved-wave' }, ctx)
      ).rejects.toBeInstanceOf(WavesOnChainException);
      scope.decisionRefs.mockResolvedValue(
        new Map([
          [
            'decision',
            { wave_id: 'moved-wave', legacy_wave_id: null, capabilities: [] }
          ]
        ])
      );
      await expect(
        assertEntriesWritable(
          [{ competition_id: 'decision', wave_id: 'moved-wave' }],
          ctx
        )
      ).rejects.toBeInstanceOf(WavesOnChainException);
      await expect(
        assertWaveWritable('staying-wave', ctx)
      ).resolves.toBeUndefined();
      await expect(
        assertDecisionWritable({ wave_id: 'staying-wave' }, ctx)
      ).resolves.toBeUndefined();
    });

    it("keeps the freeze's refusals, codes and messages before the switch-on", async () => {
      now.mockReturnValue(SWITCH_ON - 1);
      const error = await assertWaveWritable(
        'moved-wave',
        ctx,
        WAVES_FROZEN_GROUP_MESSAGE
      ).catch((e) => e);
      expect(error).toBeInstanceOf(WavesFrozenException);
      expect(error.code).toBe(WAVES_FROZEN_CODE);
      expect(error.message).toBe(WAVES_FROZEN_GROUP_MESSAGE);
      await expect(
        assertDecisionWritable({ wave_id: 'moved-wave' }, ctx)
      ).rejects.toBeInstanceOf(WavesFrozenException);
    });

    it("refuses a write that changes a wave's side with WAVES_ON_CHAIN", async () => {
      scope.waveStays.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(
        keepingWaveScope('staying-wave', ctx, async () => 'written')
      ).rejects.toBeInstanceOf(WavesOnChainException);
    });

    it('still refuses a new wave as WAVES_FROZEN after the switch-on', () => {
      expect(() => assertWaveCreationOpen()).toThrow(WavesFrozenException);
      try {
        assertWaveCreationOpen();
      } catch (error: any) {
        expect(error.code).toBe(WAVES_FROZEN_CODE);
        expect(error.message).toBe(WAVES_FROZEN_MESSAGE);
      }
    });
  });

  describe('assertNotMovedOnChain (the legacy decision pause routes)', () => {
    it('refuses a moved wave with WAVES_ON_CHAIN from the switch-on', async () => {
      await expect(
        assertNotMovedOnChain('moved-wave', ctx)
      ).rejects.toBeInstanceOf(WavesOnChainException);
      expect(scope.waveStays).toHaveBeenCalledWith('moved-wave', ctx);
    });

    it('passes a staying wave, and every wave before the switch-on', async () => {
      await expect(
        assertNotMovedOnChain('staying-wave', ctx)
      ).resolves.toBeUndefined();
      now.mockReturnValue(SWITCH_ON - 1);
      await expect(
        assertNotMovedOnChain('moved-wave', ctx)
      ).resolves.toBeUndefined();
      expect(scope.waveStays).toHaveBeenCalledTimes(1);
    });
  });
});
