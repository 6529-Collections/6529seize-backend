import { appFeatures } from '@/app-features';
import { CustomApiCompliantException } from '@/exceptions';
import { Time } from '@/time';

/**
 * 6529.io's identity freeze as the profile site routes see it.
 *
 * The identity routes get a shared helper (`isIdentityFrozen` in
 * `src/identity-freeze`, answering 423 `IDENTITY_FROZEN`). Until that is on
 * this branch, this reads the same settings and answers with the same status
 * and code; at the merge its callers switch to that helper and this file goes.
 *
 * The freeze is on when FEATURE_IDENTITY_FROZEN is `true`, or from the time in
 * IDENTITY_FREEZE_AT (ISO 8601 UTC, or Unix milliseconds). A value there that
 * is not a time freezes: whoever set it meant a freeze.
 */
export const PROFILE_CMS_FROZEN_STATUS = 423;
export const PROFILE_CMS_FROZEN_CODE = 'IDENTITY_FROZEN';

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

export function isProfileCmsIdentityFreezeOn(
  nowMillis: number = Time.currentMillis(),
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  if (env.FEATURE_IDENTITY_FROZEN === 'true') {
    return true;
  }
  const raw = env.IDENTITY_FREEZE_AT?.trim();
  if (!raw) {
    return false;
  }
  if (/^\d{1,16}$/.test(raw)) {
    return nowMillis >= Number(raw);
  }
  const start = ISO_UTC.test(raw) ? Date.parse(raw) : Number.NaN;
  return !Number.isFinite(start) || nowMillis >= start;
}

export function profileCmsFrozenError(
  message: string
): CustomApiCompliantException {
  return new CustomApiCompliantException(
    PROFILE_CMS_FROZEN_STATUS,
    message,
    PROFILE_CMS_FROZEN_CODE
  );
}

/** What the profile site and legacy CMS services ask about rollout. */
export interface ProfileCmsRollout {
  isProfileCmsChainPointerEnabled(): boolean;
  isIdentityFreezeOn(): boolean;
}

export const profileCmsRollout: ProfileCmsRollout = {
  isProfileCmsChainPointerEnabled: () =>
    appFeatures.isProfileCmsChainPointerEnabled(),
  isIdentityFreezeOn: () => isProfileCmsIdentityFreezeOn()
};
