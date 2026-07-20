import { v5 as uuidv5 } from 'uuid';

const LEGACY_COMPETITION_NAMESPACE = '8c627bf6-515c-4d9e-91f2-f718cefa1180';

export function stableUuid(namespace: string, value: string): string {
  return uuidv5(value, namespace);
}

export function legacyCompetitionId(waveId: string): string {
  return stableUuid(LEGACY_COMPETITION_NAMESPACE, waveId);
}

export function legacyCompetitionEntryId(
  competitionId: string,
  dropId: string
): string {
  return stableUuid(competitionId, `entry:${dropId}`);
}

export function legacyCompetitionDecisionId(
  competitionId: string,
  decisionTime: number
): string {
  return stableUuid(competitionId, `decision:${decisionTime}`);
}

export function legacyCompetitionOutcomeId(
  competitionId: string,
  legacyPosition: number
): string {
  return stableUuid(competitionId, `outcome:${legacyPosition}`);
}

export function legacyCompetitionDistributionItemId(
  outcomeId: string,
  legacyPosition: number
): string {
  return stableUuid(outcomeId, `distribution:${legacyPosition}`);
}

export function legacyCompetitionPauseId(
  competitionId: string,
  legacyPauseId: number | string
): string {
  return stableUuid(competitionId, `pause:${legacyPauseId}`);
}
