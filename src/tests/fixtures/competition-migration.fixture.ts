import { CompetitionMigrationService } from '@/competitions/competition-migration.service';

export const migrationFixtureOperator = {
  actor: 'fixture-operator',
  reason: 'disposable migration rehearsal'
};

export async function finishMigrationFixture(
  service: CompetitionMigrationService,
  id: string
) {
  for (let batch = 0; batch < 200; batch++) {
    const status = await service.status(id);
    if (status.migration?.state === 'SHADOWING') return;
    await service.backfill(id, migrationFixtureOperator, 100);
  }
  throw new Error('Disposable backfill did not finish');
}

/** Synthetic records exercise gates only. They are never production evidence. */
export async function approveMigrationFixture(
  service: CompetitionMigrationService,
  id: string,
  clock: { value: number }
) {
  await service.recordAcceptance(
    id,
    migrationFixtureOperator,
    migrationFixtureAcceptance(clock.value)
  );
  expect(
    (await service.compare(id, migrationFixtureOperator, 60000)).mismatches
  ).toBe(0);
  for (let window = 0; window < 7; window++) {
    clock.value += 60000;
    expect(
      (await service.compare(id, migrationFixtureOperator, 60000)).mismatches
    ).toBe(0);
  }
}

export function migrationFixtureAcceptance(now: number) {
  return {
    nativeRankCompletion: 'https://example.test/disposable/rank',
    nativeApproveCompletion: 'https://example.test/disposable/approve',
    operationalAcceptance: 'https://example.test/disposable/ops',
    compatibilityAcceptance: 'https://example.test/disposable/get',
    rollbackRehearsal: 'https://example.test/disposable/rollback',
    alertsVerified: 'https://example.test/disposable/alerts',
    productionEvidenceVerifiedBy: migrationFixtureOperator.actor,
    productionEvidenceVerifiedAt: now,
    comparisonWindowMs: 60000,
    serviceRevisions: Object.fromEntries(
      [
        'api',
        'waveDecisionExecutionLoop',
        'waveLeaderboardSnapshotterLoop',
        'tdhLoop'
      ].map((name) => [name, 'a'.repeat(40)])
    ),
    apiBaselineP95: 100,
    apiP95: 100,
    apiBudgetP95: 150,
    apiBaselineErrorRate: 0,
    apiErrorRate: 0,
    decisionBudgetP95: 60,
    decisionBudgetP99: 120,
    decisionP95: 10,
    decisionP99: 20,
    incidentWindowStartsAt: now - 1,
    incidentWindowEndsAt: now + 3600000
  };
}
