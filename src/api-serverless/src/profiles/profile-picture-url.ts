import * as Joi from 'joi';
import { getAcceptedMediaOrigins, getUserMediaOrigin } from '@/constants';
import { BadRequestException } from '@/exceptions';
import { Logger } from '@/logging';

const logger = Logger.get('PROFILE_PICTURE_URL');

// Any ipfs:// value is accepted today, so this stays the accepted form until
// PROFILE_PICTURE_IPFS_URLS_STRICT is switched on.
const ANY_IPFS_URL_REGEX = /^ipfs:\/\/.+$/;

// A bare CID, as both upload flows (the API pin and the desktop app's local
// node) save it: CIDv0 (base58btc, 46 characters) or base32 CIDv1.
const BARE_CID_IPFS_URL_REGEX =
  /^ipfs:\/\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

function invalidProfilePictureUrlMessage(): string {
  return `Profile picture must be an ipfs:// link or an image URL starting with ${getUserMediaOrigin()}/`;
}

/**
 * An accepted media host, then a non-empty path without whitespace: nothing
 * (userinfo, a port, a longer host name) can sit between the host and the
 * first slash.
 */
export function isMediaHostUrl(value: string): boolean {
  if (/\s/.test(value)) {
    return false;
  }
  return getAcceptedMediaOrigins().some((origin) => {
    const prefix = `${origin}/`;
    if (!value.startsWith(prefix) || value.length === prefix.length) {
      return false;
    }
    try {
      const url = new URL(value);
      const expected = new URL(origin);
      return (
        url.protocol === expected.protocol &&
        url.hostname === expected.hostname &&
        url.port === '' &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  });
}

export function isBareCidIpfsUrl(value: string): boolean {
  return BARE_CID_IPFS_URL_REGEX.test(value);
}

function isStrictIpfsFormEnforced(): boolean {
  return process.env.PROFILE_PICTURE_IPFS_URLS_STRICT === 'true';
}

/** Coarse description of an ipfs:// value, safe to log and to count. */
export function describeIpfsUrlShape(value: string): string {
  const rest = value.slice('ipfs://'.length);
  if (rest.startsWith('ipfs/')) {
    return 'ipfs_path_prefix';
  }
  if (/[?#]/.test(rest)) {
    return 'query_or_fragment';
  }
  if (rest.includes('/')) {
    return 'cid_with_path';
  }
  if (/\s/.test(rest)) {
    return 'whitespace';
  }
  return 'other_cid_form';
}

function checkIpfsUrl(value: string): boolean {
  if (isBareCidIpfsUrl(value)) {
    return true;
  }
  const strict = isStrictIpfsFormEnforced();
  logger.warn(
    `[PROFILE_PICTURE_IPFS_FORM] ${JSON.stringify({
      outcome: strict ? 'rejected' : 'accepted',
      shape: describeIpfsUrlShape(value),
      length: value.length
    })}`
  );
  return !strict;
}

// What POST /profiles has always accepted. Profile edits resend the stored
// picture URL, so a stored value keeps passing this even when it would fail
// the exact checks below.
const PREVIOUSLY_ACCEPTED_URL_REGEX =
  /^(?:ipfs:\/\/|https:\/\/d3lqz0a4bldqgf).+$/;

/**
 * Request-level shape of `pfp_url`: what was always accepted, plus a URL on
 * this environment's media host when that is not the prod CDN.
 */
export const ProfilePictureUrlSchema = Joi.string().custom(
  (value: string, helpers) =>
    PREVIOUSLY_ACCEPTED_URL_REGEX.test(value) || isMediaHostUrl(value)
      ? value
      : helpers.error('string.pattern.base', {
          regex: PREVIOUSLY_ACCEPTED_URL_REGEX,
          name: undefined
        })
);

/**
 * Whether a newly set `pfp_url` is allowed: an image on the media host
 * (checked exactly: scheme, host, no userinfo or port) or an ipfs:// link.
 * ipfs:// links that are not a bare CID are logged and, until the strict
 * switch is on, still accepted.
 */
export function isAllowedNewProfilePictureUrl(value: string): boolean {
  return (
    isMediaHostUrl(value) ||
    (ANY_IPFS_URL_REGEX.test(value) && checkIpfsUrl(value))
  );
}

/**
 * Applies the exact checks only when `submitted` differs from every value
 * already stored for the profile: an unchanged picture URL is kept as it is,
 * so edits that resend it (name, banner, classification) keep working.
 */
export function assertProfilePictureUrlChangeAllowed(
  submitted: string | null | undefined,
  stored: ReadonlyArray<string | null | undefined>
): void {
  if (submitted === null || submitted === undefined) {
    return;
  }
  if (stored.some((value) => value === submitted)) {
    return;
  }
  if (!isAllowedNewProfilePictureUrl(submitted)) {
    throw new BadRequestException(invalidProfilePictureUrlMessage());
  }
}
