import type { ReleaseBusMode } from '@/releaseBus/release-bus.types';

const MODES = new Set<ReleaseBusMode>([
  'OFF',
  'SHADOW',
  'STAGING',
  'PRODUCTION'
]);

export function getReleaseBusMode(): ReleaseBusMode {
  const configured = (process.env.RELEASE_BUS_MODE ?? 'OFF').toUpperCase();
  return MODES.has(configured as ReleaseBusMode)
    ? (configured as ReleaseBusMode)
    : 'OFF';
}

export function releaseBusAllowsProduction(): boolean {
  return getReleaseBusMode() === 'PRODUCTION';
}

export const RELEASE_BUS_OPERATOR_TEAM =
  process.env.RELEASE_BUS_OPERATOR_TEAM ?? 'release-bus-operators';
export const RELEASE_BUS_ORG =
  process.env.RELEASE_BUS_GITHUB_ORG ?? '6529-Collections';
export const RELEASE_BUS_LANE_TTL_MS = 5 * 60 * 1000;
const configuredMaxTrainCandidates = Number(
  process.env.RELEASE_BUS_MAX_TRAIN_CANDIDATES ?? 20
);
export const RELEASE_BUS_MAX_TRAIN_CANDIDATES =
  Number.isInteger(configuredMaxTrainCandidates) &&
  configuredMaxTrainCandidates > 0
    ? Math.min(configuredMaxTrainCandidates, 50)
    : 20;
