import { appFeatures } from '@/app-features';
import { CustomApiCompliantException } from '@/exceptions';

/**
 * Identities move to the 6529 chain. From the freeze (FEATURE_IDENTITY_FROZEN)
 * 6529.io stops changing profiles, handles, profile statements, REP and NIC
 * ratings and REP/NIC proxy allocations: the chain imports them as they stand
 * at the freeze, and from switch-on people change them on the chain through
 * this site. Waves, drops and wave proxies are not frozen.
 */
export const IDENTITY_FROZEN_CODE = 'IDENTITY_FROZEN';

export const IDENTITY_FROZEN_STATUS = 423;

export const IDENTITY_FROZEN_MESSAGE =
  `Profiles, handles, REP and NIC are moving to the 6529 Network, ` +
  `so they can't be changed here right now. ` +
  `Soon you will change them on the 6529 Network, through this site.`;

export const IDENTITY_FROZEN_NOMINATION_MESSAGE =
  `This wallet has no profile yet, and new profiles can't be made here ` +
  `while profiles move to the 6529 Network. ` +
  `Nominate a wallet that already has a profile, or try again later.`;

export class IdentityFrozenException extends CustomApiCompliantException {
  constructor(message: string = IDENTITY_FROZEN_MESSAGE) {
    super(IDENTITY_FROZEN_STATUS, message, IDENTITY_FROZEN_CODE);
  }
}

export function isIdentityFrozen(): boolean {
  return appFeatures.isIdentityFrozen();
}

/** Throws IdentityFrozenException while identities are frozen. */
export function assertIdentityNotFrozen(
  message: string = IDENTITY_FROZEN_MESSAGE
): void {
  if (isIdentityFrozen()) {
    throw new IdentityFrozenException(message);
  }
}
