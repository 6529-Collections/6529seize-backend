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

function enabled(name: string): boolean {
  return (process.env[name] ?? 'false').toLowerCase() === 'true';
}

export function getBaseCanaryEvidenceConfig(): {
  readonly reuse: boolean;
  readonly shadow: boolean;
  readonly maxAgeHours: number;
} {
  const configuredMaxAge = Number(
    process.env.RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS ?? 24
  );
  const maxAgeIsValid =
    Number.isInteger(configuredMaxAge) &&
    configuredMaxAge >= 1 &&
    configuredMaxAge <= 168;
  return {
    reuse: maxAgeIsValid && enabled('RELEASE_BUS_BASE_EVIDENCE_REUSE'),
    shadow: maxAgeIsValid && enabled('RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW'),
    maxAgeHours: maxAgeIsValid ? configuredMaxAge : 24
  };
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

export function getBackendDeployConcurrency(): number {
  const configured = Number(
    process.env.RELEASE_BUS_BACKEND_DEPLOY_CONCURRENCY ?? 20
  );
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 50)
    : 20;
}
