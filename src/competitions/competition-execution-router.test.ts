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
});
