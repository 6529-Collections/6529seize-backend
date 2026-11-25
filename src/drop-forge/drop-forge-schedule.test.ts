import { standardLaunchPlan } from '@/drop-forge/drop-forge.schedule';
import { getMintNumberForMintDate, getMintSchedule } from '@/memes-calendar';
import { testConfig, testSource } from '@/drop-forge/drop-forge.test-fixtures';
import { buildLaunchPlan } from '@/drop-forge/drop-forge.plan';
import { isResearchAirdrop } from '@/drop-forge/drop-forge.research';
const source = {
  ...testSource,
  rows: [0, 1, 2].map((n) => ({ ...testSource.rows[0], phase: `Phase ${n}` }))
};
it.each(['2026-10-23', '2026-10-26', '2026-03-27', '2026-03-30'])(
  'derives local phase gaps and persists the version for %s without HTTP',
  (day) => {
    const claim = getMintNumberForMintDate(new Date(day + 'T00:00:00Z'));
    const calendar = getMintSchedule(claim);
    const start = calendar.phases[0].start.getTime() / 1000;
    const end = calendar.mintEnd.getTime() / 1000;
    const input = standardLaunchPlan(claim, source, start - 3600);
    const plan = buildLaunchPlan(
      testConfig,
      claim,
      input,
      source,
      start - 3600,
      true
    );
    expect(plan.phases.map((p) => [p.start, p.end])).toEqual([
      [start, start + 2400],
      [start + 3000, start + 4200],
      [start + 4800, start + 6000],
      [start + 6000, end]
    ]);
    expect(plan.calendar).toEqual({
      version: calendar.version,
      time_zone: 'Europe/Athens'
    });
    expect(plan.actions.find(isResearchAirdrop)?.due).toBe(
      calendar.postMintAt.getTime() / 1000
    );
    input.phases[0].start += 60;
    expect(plan.phases[0].start).toBe(start);
  }
);
it('rejects a mint already started or incomplete distribution', () => {
  const claim = 564;
  const start = getMintSchedule(claim).phases[0].start.getTime() / 1000;
  expect(() => standardLaunchPlan(claim, source, start)).toThrow('future mint');
  expect(() =>
    standardLaunchPlan(claim, { ...source, rows: [] }, start - 3600)
  ).toThrow('Phase 0');
});
