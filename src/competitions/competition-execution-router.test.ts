import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import { CompetitionExecutionMode } from '@/entities/ICompetition';

const router = new CompetitionExecutionRouter();

it.each([
  [CompetitionExecutionMode.ACTIVE, true],
  [CompetitionExecutionMode.DISABLED, false]
])(
  'enforces execution mode %s independently of storage',
  (execution_mode, expected) => {
    expect(router.isNativeExecutionAllowed({ execution_mode })).toBe(expected);
  }
);

describe('during the waves freeze', () => {
  const names = [
    'FEATURE_WAVES_FROZEN',
    'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
    'WAVES_FREEZE_AT',
    'MAIN_STAGE_WAVE_ID'
  ];
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of names) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of names) delete process.env[name];
    process.env.FEATURE_WAVES_FROZEN = 'true';
  });
  afterAll(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const active = CompetitionExecutionMode.ACTIVE;

  it('runs no competition: results and leaderboards stay as frozen', () => {
    expect(
      router.isNativeExecutionAllowed({
        execution_mode: active,
        capabilities: [],
        wave_id: 'wave'
      })
    ).toBe(false);
    expect(
      router.isNativeExecutionAllowed({
        execution_mode: active,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(false);
  });

  it('runs only the Main Stage when the freeze keeps it', () => {
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    expect(
      router.isNativeExecutionAllowed({
        execution_mode: active,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(true);
    expect(
      router.isNativeExecutionAllowed({
        execution_mode: CompetitionExecutionMode.DISABLED,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(false);
    expect(
      router.isNativeExecutionAllowed({
        execution_mode: active,
        capabilities: ['CURATION'],
        wave_id: 'curation'
      })
    ).toBe(false);
  });

  // The freeze starts Wed 25 Nov 00:00 UTC and row 7 Thu 26 Nov 00:00 UTC,
  // so the Main Stage's Wed 25 Nov 16:00 result falls inside the freeze.
  describe('a Main Stage result inside the freeze', () => {
    const tueResult = Date.UTC(2026, 10, 24, 16, 0, 0);
    const wedResult = Date.UTC(2026, 10, 25, 16, 0, 0);
    const mainStage = {
      execution_mode: active,
      capabilities: ['MAIN_STAGE'],
      wave_id: 'main'
    };
    const other = { execution_mode: active, capabilities: [], wave_id: 'wave' };

    beforeEach(() => {
      delete process.env.FEATURE_WAVES_FROZEN;
      process.env.WAVES_FREEZE_AT = '2026-11-25T00:00:00Z';
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const at = (millis: number) =>
      jest.spyOn(Date, 'now').mockReturnValue(millis);

    it('settles the result before the freeze as usual', () => {
      at(tueResult);
      expect(router.isNativeExecutionAllowed(mainStage)).toBe(true);
      expect(router.isNativeExecutionAllowed(other)).toBe(true);
    });

    it('holds it by default', () => {
      at(wedResult);
      expect(router.isNativeExecutionAllowed(mainStage)).toBe(false);
      expect(router.isNativeExecutionAllowed(other)).toBe(false);
    });

    it('settles it here when the freeze keeps the Main Stage', () => {
      process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
      at(wedResult);
      expect(router.isNativeExecutionAllowed(mainStage)).toBe(true);
      expect(router.isNativeExecutionAllowed(other)).toBe(false);
    });
  });
});
