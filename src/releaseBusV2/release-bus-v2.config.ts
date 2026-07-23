import type { ReleaseBusV2Mode } from '@/releaseBusV2/release-bus-v2.types';

const MODES = new Set<ReleaseBusV2Mode>(['OFF', 'STAGING', 'PRODUCTION']);

export function getReleaseBusV2Mode(): ReleaseBusV2Mode {
  const configured = (process.env.RELEASE_BUS_V2_MODE ?? 'OFF').toUpperCase();
  return MODES.has(configured as ReleaseBusV2Mode)
    ? (configured as ReleaseBusV2Mode)
    : 'OFF';
}

export function releaseBusV2AllowsLane(
  mode: ReleaseBusV2Mode,
  lane: 'STAGING' | 'PRODUCTION'
): boolean {
  return mode === 'PRODUCTION' || (mode === 'STAGING' && lane === 'STAGING');
}

export const RELEASE_BUS_V2_LOCK_TTL_MS = 5 * 60 * 1000;
export const RELEASE_BUS_V2_MAX_CANDIDATES = 50;
