import {
  IdentityFrozenException,
  isIdentityFrozen
} from '@/identity-freeze/identity-freeze';

/**
 * xTDH stops changing with the identity freeze (the identity plan's B1, one
 * flag: FEATURE_IDENTITY_FROZEN or IDENTITY_FREEZE_AT). The 6529 chain
 * imports each identity's xTDH as it stands at the freeze, and grants come
 * back only as one-time grants on the chain (owner, 13 Nov: "to be
 * redesigned"). From the freeze, grants can't be created or changed, and the
 * xTDH recalculation and the grants review don't run. Reads stay.
 */
export const XTDH_FROZEN_MESSAGE =
  `xTDH is frozen. Grants can't be created or changed ` +
  `until one-time grants exist on the 6529 chain.`;

export function isXTdhFrozen(nowMillis?: number): boolean {
  return isIdentityFrozen(nowMillis);
}

/** Throws (HTTP 423, code IDENTITY_FROZEN) while xTDH is frozen. */
export function assertXTdhNotFrozen(): void {
  if (isXTdhFrozen()) {
    throw new IdentityFrozenException(XTDH_FROZEN_MESSAGE);
  }
}
