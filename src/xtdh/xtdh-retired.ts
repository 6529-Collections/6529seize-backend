import {
  IdentityFrozenException,
  isIdentityFrozen
} from '@/identity-freeze/identity-freeze';

/**
 * xTDH is retired when identities move to the 6529 Network: the chain takes
 * no xTDH and no grants over. It follows the identity freeze's own settings
 * (FEATURE_IDENTITY_FROZEN or IDENTITY_FREEZE_AT), which stay on for good
 * from the identity switch-on. From then on grants can't be created or
 * changed, and the xTDH recalculation and the grant review don't run. Reads
 * stay.
 */
export const XTDH_RETIRED_MESSAGE =
  `xTDH was retired when identities moved to the 6529 Network. ` +
  `Grants can't be created or changed.`;

export function isXTdhRetired(nowMillis?: number): boolean {
  return isIdentityFrozen(nowMillis);
}

/** Throws (HTTP 423, code IDENTITY_FROZEN) once xTDH is retired. */
export function assertXTdhNotRetired(): void {
  if (isXTdhRetired()) {
    throw new IdentityFrozenException(XTDH_RETIRED_MESSAGE);
  }
}
