import { Time } from '@/time';
import {
  assertBallotNotClosedAtMove,
  movedPollsCloseAt,
  openAtMove,
  pollAsShown,
  WAVES_POLL_CLOSED_AT_MOVE_CODE,
  WAVES_POLL_CLOSED_AT_MOVE_MESSAGE,
  wavePollsCloseAt,
  WavesPollClosedAtMoveException,
  withPollsClosedAtMove
} from '@/waves-freeze/waves-moved-polls';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT'
];
const FREEZE = Date.UTC(2026, 10, 27);
const SWITCH_ON = Date.UTC(2026, 10, 28);
const LATER = Date.UTC(2026, 11, 5);

/** A poll made before the freeze and still open at it. */
const openAtFreeze = (waveId: string) => ({
  id: `poll-${waveId}`,
  wave_id: waveId,
  closing_time: LATER,
  created_at: FREEZE - 60_000
});

const ctx = {};

describe('polls still open at the freeze, from the switch-on', () => {
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

  describe('movedPollsCloseAt', () => {
    it('is the freeze time from the switch-on, and null before it', () => {
      expect(movedPollsCloseAt(SWITCH_ON)).toBe(FREEZE);
      expect(movedPollsCloseAt(SWITCH_ON - 1)).toBeNull();
    });

    it('is null with no freeze time (the freeze flag alone)', () => {
      delete process.env.WAVES_FREEZE_AT;
      process.env.FEATURE_WAVES_FROZEN = 'true';
      expect(movedPollsCloseAt(SWITCH_ON)).toBeNull();
    });
  });

  describe('openAtMove and pollAsShown', () => {
    it('closes a poll made before the freeze and open at it, at the freeze', () => {
      const poll = openAtFreeze('moved-wave');
      expect(openAtMove(poll, FREEZE)).toBe(true);
      expect(pollAsShown(poll, FREEZE)).toEqual({
        ...poll,
        closing_time: FREEZE
      });
    });

    it('leaves a poll that closed before the freeze as it is', () => {
      const poll = { ...openAtFreeze('moved-wave'), closing_time: FREEZE - 1 };
      expect(openAtMove(poll, FREEZE)).toBe(false);
      expect(pollAsShown(poll, FREEZE)).toBe(poll);
      const atFreeze = { ...poll, closing_time: FREEZE };
      expect(pollAsShown(atFreeze, FREEZE)).toBe(atFreeze);
    });

    it('leaves a poll made after the freeze (on the chain) as it is', () => {
      const poll = { ...openAtFreeze('moved-wave'), created_at: FREEZE + 1 };
      expect(pollAsShown(poll, FREEZE)).toBe(poll);
    });

    it('counts a poll whose drop time is unknown as made before the freeze', () => {
      const poll = { ...openAtFreeze('moved-wave'), created_at: undefined };
      expect(pollAsShown(poll, FREEZE).closing_time).toBe(FREEZE);
    });

    it('reads stored times given as text', () => {
      const poll = {
        wave_id: 'moved-wave',
        closing_time: String(LATER) as unknown as number,
        created_at: String(FREEZE - 1) as unknown as number
      };
      expect(openAtMove(poll, FREEZE)).toBe(true);
    });

    it('changes nothing without a close time', () => {
      const poll = openAtFreeze('moved-wave');
      expect(pollAsShown(poll, null)).toBe(poll);
    });
  });

  describe('withPollsClosedAtMove (every place a poll is served)', () => {
    it("closes a moved wave's poll at the freeze, and keeps a staying wave's", async () => {
      const polls = {
        'drop-moved': openAtFreeze('moved-wave'),
        'drop-staying': openAtFreeze('staying-wave'),
        'drop-closed': {
          ...openAtFreeze('other-moved-wave'),
          closing_time: FREEZE - 1
        }
      };
      const shown = await withPollsClosedAtMove(polls, ctx);
      expect(shown['drop-moved'].closing_time).toBe(FREEZE);
      expect(shown['drop-staying']).toBe(polls['drop-staying']);
      expect(shown['drop-closed']).toBe(polls['drop-closed']);
      expect(scope.staysForDisplay).toHaveBeenCalledTimes(1);
      expect(scope.staysForDisplay).toHaveBeenCalledWith(
        ['moved-wave', 'staying-wave'],
        ctx
      );
    });

    it('changes nothing before the switch-on, and reads no wave', async () => {
      now.mockReturnValue(SWITCH_ON - 1);
      const polls = { 'drop-moved': openAtFreeze('moved-wave') };
      expect(await withPollsClosedAtMove(polls, ctx)).toBe(polls);
      expect(scope.staysForDisplay).not.toHaveBeenCalled();
    });

    it('reads no wave when no poll was open at the freeze', async () => {
      const polls = {
        'drop-closed': { ...openAtFreeze('moved-wave'), closing_time: 1 }
      };
      expect(await withPollsClosedAtMove(polls, ctx)).toBe(polls);
      expect(scope.staysForDisplay).not.toHaveBeenCalled();
    });
  });

  describe('wavePollsCloseAt (the Polls tab)', () => {
    it('is the freeze time for a moved wave, null for a staying one', async () => {
      expect(await wavePollsCloseAt('moved-wave', ctx)).toBe(FREEZE);
      expect(await wavePollsCloseAt('staying-wave', ctx)).toBeNull();
    });

    it('is null before the switch-on, reading no wave', async () => {
      now.mockReturnValue(SWITCH_ON - 1);
      expect(await wavePollsCloseAt('moved-wave', ctx)).toBeNull();
      expect(scope.staysForDisplay).not.toHaveBeenCalled();
    });
  });

  describe('assertBallotNotClosedAtMove (the vote path)', () => {
    it('refuses a ballot on a poll open at the freeze in a moved wave: 400, its code, its message', async () => {
      const error = await assertBallotNotClosedAtMove(
        openAtFreeze('moved-wave'),
        ctx
      ).catch((e) => e);
      expect(error).toBeInstanceOf(WavesPollClosedAtMoveException);
      expect(error.getStatusCode()).toBe(400);
      expect(error.code).toBe(WAVES_POLL_CLOSED_AT_MOVE_CODE);
      expect(error.message).toBe(WAVES_POLL_CLOSED_AT_MOVE_MESSAGE);
      // The wording the frontend shows, word for word.
      expect(WAVES_POLL_CLOSED_AT_MOVE_MESSAGE).toBe(
        'This poll closed when the wave moved to the 6529 Network.'
      );
      expect(scope.waveStays).toHaveBeenCalledWith('moved-wave', ctx);
    });

    it('lets a staying wave, an earlier close, a later poll and the time before the switch-on through', async () => {
      await expect(
        assertBallotNotClosedAtMove(openAtFreeze('staying-wave'), ctx)
      ).resolves.toBeUndefined();
      await expect(
        assertBallotNotClosedAtMove(
          { ...openAtFreeze('moved-wave'), closing_time: FREEZE - 1 },
          ctx
        )
      ).resolves.toBeUndefined();
      await expect(
        assertBallotNotClosedAtMove(
          { ...openAtFreeze('moved-wave'), created_at: FREEZE + 1 },
          ctx
        )
      ).resolves.toBeUndefined();
      now.mockReturnValue(SWITCH_ON - 1);
      await expect(
        assertBallotNotClosedAtMove(openAtFreeze('moved-wave'), ctx)
      ).resolves.toBeUndefined();
    });
  });
});
