import {
  COMPETITIONS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import type { SqlExecutor } from '@/sql-executor';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from './legacy-competition-get-facade';
import {
  assertCompetitionHistoryPreparationAllowed,
  isCompetitionRuntimeRetired
} from './competition-runtime-retirement-state';

function nativeViews(): { name: string; definition: string | null }[] {
  return LEGACY_GET_SOURCE_TABLES.map((table) => ({
    name: legacyGetView(table),
    definition: `select c.id from \`test\`.\`${COMPETITIONS_TABLE}\` c join \`test\`.\`${COMPETITION_SCORE_HISTORY_TABLE}\` h on h.competition_id=c.id`
  }));
}
const database = (views: ReturnType<typeof nativeViews>) =>
  ({
    execute: jest.fn().mockResolvedValue(views)
  }) as unknown as SqlExecutor;

it('requires every native view before treating retirement as complete', async () => {
  expect(await isCompetitionRuntimeRetired(database(nativeViews()))).toBe(true);
  expect(await isCompetitionRuntimeRetired(database([]))).toBe(false);
  expect(
    await isCompetitionRuntimeRetired(database(nativeViews().slice(1)))
  ).toBe(false);
});

it.each(
  LEGACY_GET_SOURCE_TABLES.filter(
    (table) => table !== WAVES_TABLE && table !== DROPS_TABLE
  )
)(
  'does not accept a retained dependency on %s, including a partially switched set',
  async (table) => {
    const views = nativeViews();
    views.find((view) => view.name === legacyGetView(table))!.definition +=
      ` join \`test\`.\`${table}\` source`;
    expect(await isCompetitionRuntimeRetired(database(views))).toBe(false);
  }
);

it('does not accept the prepared wave-only physical configuration fallback', async () => {
  const views = nativeViews();
  views.find((view) => view.name === legacyGetView(WAVES_TABLE))!.definition +=
    ' where `w`.`type`=c.type';
  expect(await isCompetitionRuntimeRetired(database(views))).toBe(false);
});

it('requires actual native score history in the retained history views', async () => {
  const views = nativeViews();
  views.find(
    (view) => view.name === legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)
  )!.definition = `select c.id from ${COMPETITIONS_TABLE} c`;
  expect(await isCompetitionRuntimeRetired(database(views))).toBe(false);
});

it('fails closed when complete view definitions cannot be inspected', async () => {
  const views = nativeViews();
  views[0].definition = null;
  await expect(isCompetitionRuntimeRetired(database(views))).rejects.toThrow(
    'Unable to inspect'
  );
});

it('rejects stale source preparation after cutover while permitting pre-cutover retries', async () => {
  await expect(
    assertCompetitionHistoryPreparationAllowed(database(nativeViews()))
  ).rejects.toThrow('retained sources are no longer authoritative');
  await expect(
    assertCompetitionHistoryPreparationAllowed(database(nativeViews().slice(1)))
  ).resolves.toBeUndefined();
});
