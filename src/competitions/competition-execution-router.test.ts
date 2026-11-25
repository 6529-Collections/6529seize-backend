import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import { CompetitionExecutionMode } from '@/entities/ICompetition';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const router = new CompetitionExecutionRouter();
const allowed = (
  record: Parameters<CompetitionExecutionRouter['isNativeExecutionAllowed']>[0]
) => router.isNativeExecutionAllowed(record, {});

it.each([
  [CompetitionExecutionMode.ACTIVE, true],
  [CompetitionExecutionMode.DISABLED, false]
])(
  'enforces execution mode %s independently of storage',
  async (execution_mode, expected) => {
    expect(await allowed({ execution_mode })).toBe(expected);
  }
);

// Every wave moves unless a test says otherwise.
beforeEach(() => {
  stubWavesScope();
});

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

  it('runs no competition: results and leaderboards stay as frozen', async () => {
    expect(
      await allowed({
        execution_mode: active,
        capabilities: [],
        wave_id: 'wave'
      })
    ).toBe(false);
    expect(
      await allowed({
        execution_mode: active,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(false);
  });

  it("runs a staying wave's decisions as usual", async () => {
    stubWavesScope({ staying: ['members-only'] });
    expect(
      await allowed({
        execution_mode: active,
        capabilities: [],
        wave_id: 'members-only'
      })
    ).toBe(true);
    expect(
      await allowed({
        execution_mode: CompetitionExecutionMode.DISABLED,
        capabilities: [],
        wave_id: 'members-only'
      })
    ).toBe(false);
    expect(
      await allowed({ execution_mode: active, capabilities: [], wave_id: 'w' })
    ).toBe(false);
  });

  it('runs only the Main Stage when the freeze keeps it', async () => {
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    expect(
      await allowed({
        execution_mode: active,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(true);
    expect(
      await allowed({
        execution_mode: CompetitionExecutionMode.DISABLED,
        capabilities: ['MAIN_STAGE'],
        wave_id: 'main'
      })
    ).toBe(false);
    expect(
      await allowed({
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

    it('settles the result before the freeze as usual', async () => {
      at(tueResult);
      expect(await allowed(mainStage)).toBe(true);
      expect(await allowed(other)).toBe(true);
    });

    it('holds it by default', async () => {
      at(wedResult);
      expect(await allowed(mainStage)).toBe(false);
      expect(await allowed(other)).toBe(false);
    });

    it('settles it here when the freeze keeps the Main Stage', async () => {
      process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
      at(wedResult);
      expect(await allowed(mainStage)).toBe(true);
      expect(await allowed(other)).toBe(false);
    });
  });
});
