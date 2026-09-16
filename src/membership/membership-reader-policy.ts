/** Controlled reader validation is intentionally unavailable in production. */
export type MembershipReaderMode = 'legacy' | 'staging-controlled-v1';

export interface MembershipReaderPolicy {
  readonly read: boolean;
  readonly shadow: boolean;
}

// API modules load before loadSecrets(). Capture only deployment-owned controls.
// Later secret refreshes and request-time environment mutation cannot enable reads.
const readerControls = Object.freeze({
  stage: process.env.MEMBERSHIP_READER_STAGE,
  readMode: process.env.MEMBERSHIP_READ_MODE,
  shadowMode: process.env.MEMBERSHIP_SHADOW_MODE,
  profileIds: process.env.MEMBERSHIP_READER_PROFILE_IDS,
  coverageRevision: process.env.MEMBERSHIP_READER_COVERAGE_REVISION
});

export function membershipReaderCoverageRevision(): string | null {
  const revision = readerControls.coverageRevision;
  return revision && /^[A-Za-z0-9_.:/-]{1,100}$/.test(revision)
    ? revision
    : null;
}

function controlled(mode: string | undefined, profileId: string): boolean {
  if (mode !== 'staging-controlled-v1') return false;
  // The workflow owns this value; NODE_ENV can be production on staging.
  if (readerControls.stage !== 'staging') return false;
  const ids = (readerControls.profileIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  // Keep the 20-profile cap aligned with the deploy generator's allowlist validation.
  return ids.length > 0 && ids.length <= 20 && ids.includes(profileId);
}

export function membershipReaderPolicy(
  profileId: string
): MembershipReaderPolicy {
  return {
    read: controlled(readerControls.readMode, profileId),
    shadow: controlled(readerControls.shadowMode, profileId)
  };
}
