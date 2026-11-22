import { ethers } from 'ethers';
import {
  computeAppDeviceGrantId,
  parseAppDeviceGrantMessage,
  recoversToAppGrantWallet
} from '@/api/device-signing/app-device-grant';
import {
  computeDeviceEventId,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind,
  verifyEd25519EventSignature,
  ZERO_BODY_HASH
} from '@/api/device-signing/device-event';
import {
  computeDeviceGrantId,
  DeviceGrantScope
} from '@/api/device-signing/device-grant-message';
import { parseSiweWebAuthMessage } from '@/api/wallet-signatures/siwe-wallet-auth';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';

/**
 * The checks every reader of a relay makes on an event and the grant proof
 * it travels with, as the validator's `wave-events` crate makes them
 * (verify.rs `check_event`): sizes, kind, the event's binding to its grant
 * and the grant's scope, the body's commitment, the event id, the device
 * key's signature, then the grant: its terms against the message the
 * wallet signed and the wallet's signature over it, its expiry and
 * revocation at the event's claimed time.
 *
 * A grant 6529.io already holds (device_grants) was verified when it was
 * registered, contract wallets included; any other grant must be an
 * ordinary wallet's signature this server can check.
 */

export interface RelayEvent {
  readonly id: string;
  readonly kind: DeviceEventKind;
  readonly kindVersion: number;
  readonly wave: string;
  /** The author's wallet, lowercase. */
  readonly author: string;
  readonly keyType: number;
  readonly deviceKey: string;
  /** The grant's id. */
  readonly authRef: string;
  readonly seq: number;
  readonly anchor: number;
  readonly claimedTime: number;
  readonly refs: string[];
  /** The canonical body exactly as hashed, or null. */
  readonly body: string | null;
  readonly bodyHash: string;
  readonly bodySize: number;
  readonly signature: string;
}

export interface RelayGrant {
  readonly id: string;
  readonly message: string;
  readonly walletSignature: string;
  readonly chainId: number;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly scopes: string[];
  readonly domain: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export type RelayEventCheck =
  | {
      readonly ok: true;
      readonly event: RelayEvent;
      readonly grant: RelayGrant;
      /**
       * How the grant was verified: held by 6529.io, its wallet's signature
       * checked here, or neither (a contract wallet's, which wave-events
       * also takes unchecked; never written into 6529.io's tables).
       */
      readonly grantVia: 'known' | 'signature' | 'unverifiable';
    }
  | { readonly ok: false; readonly reason: string };

/** wave-events' default limits. */
export const RELAY_EVENT_LIMITS = {
  maxBodyBytes: 1 << 20,
  maxRefs: 16,
  maxStringBytes: 1024
} as const;

const KIND_SCOPES: Record<DeviceEventKind, DeviceGrantScope> = {
  [DeviceEventKind.POST]: 'post',
  [DeviceEventKind.EDIT]: 'edit',
  [DeviceEventKind.TOMBSTONE]: 'delete',
  [DeviceEventKind.REACT]: 'react'
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function uint(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The event's fields, or why they can't be read. */
export function readRelayEvent(
  raw: Record<string, unknown>
): RelayEvent | string {
  const id = str(raw.id);
  const kind = uint(raw.kind);
  const kindVersion = uint(raw.kind_version);
  const wave = str(raw.wave);
  const author = str(raw.author);
  const keyType = uint(raw.key_type);
  const deviceKey = str(raw.device_key);
  const authRef = str(raw.auth_ref);
  const seq = uint(raw.seq);
  const anchor = uint(raw.anchor);
  const claimedTime = uint(raw.claimed_time);
  const refs = Array.isArray(raw.refs) ? raw.refs : null;
  const body =
    raw.body === null || raw.body === undefined ? null : str(raw.body);
  const bodyHash = str(raw.body_hash);
  const bodySize = uint(raw.body_size);
  const signature = str(raw.signature);
  if (
    !id ||
    !HEX32.test(id) ||
    kind === null ||
    kindVersion === null ||
    wave === null ||
    !author ||
    !ADDRESS.test(author) ||
    keyType === null ||
    !deviceKey ||
    !authRef ||
    seq === null ||
    anchor === null ||
    claimedTime === null ||
    !refs ||
    !refs.every((ref) => typeof ref === 'string') ||
    (raw.body !== null && raw.body !== undefined && body === null) ||
    !bodyHash ||
    bodySize === null ||
    !signature
  ) {
    return 'unreadable event';
  }
  return {
    id: id.toLowerCase(),
    kind,
    kindVersion,
    wave,
    author: author.toLowerCase(),
    keyType,
    deviceKey: deviceKey.toLowerCase(),
    authRef: authRef.toLowerCase(),
    seq,
    anchor,
    claimedTime,
    refs: refs as string[],
    body,
    bodyHash: bodyHash.toLowerCase(),
    bodySize,
    signature: signature.toLowerCase()
  };
}

/** The grant proof's fields, or why they can't be read. */
export function readRelayGrant(
  raw: Record<string, unknown>
): RelayGrant | string {
  const id = str(raw.id);
  const message = str(raw.message);
  const walletSignature = str(raw.wallet_signature);
  const chainId = uint(raw.chain_id);
  const wallet = str(raw.wallet);
  const deviceKey = str(raw.device_key);
  const scopes = Array.isArray(raw.scopes) ? raw.scopes : null;
  const domain = str(raw.domain);
  const expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at : null;
  const revokedAt =
    raw.revoked_at === null || raw.revoked_at === undefined
      ? null
      : typeof raw.revoked_at === 'number'
        ? raw.revoked_at
        : undefined;
  if (
    !id ||
    !HEX32.test(id) ||
    message === null ||
    !walletSignature ||
    chainId === null ||
    !wallet ||
    !ADDRESS.test(wallet) ||
    !deviceKey ||
    !scopes ||
    !scopes.every((scope) => typeof scope === 'string') ||
    domain === null ||
    expiresAt === null ||
    revokedAt === undefined
  ) {
    return 'unreadable grant';
  }
  return {
    id: id.toLowerCase(),
    message,
    walletSignature,
    chainId,
    wallet: wallet.toLowerCase(),
    deviceKey: deviceKey.toLowerCase(),
    scopes: scopes as string[],
    domain,
    expiresAt,
    revokedAt
  };
}

function sizeProblem(event: RelayEvent): string | null {
  const { maxBodyBytes, maxRefs, maxStringBytes } = RELAY_EVENT_LIMITS;
  if (event.body !== null && utf8Bytes(event.body) > maxBodyBytes) {
    return 'body too large';
  }
  if (event.refs.length > maxRefs) return 'too many refs';
  if (
    utf8Bytes(event.wave) > maxStringBytes ||
    event.refs.some((ref) => utf8Bytes(ref) > maxStringBytes)
  ) {
    return 'string too long';
  }
  return null;
}

/** The body is canonical JSON and is what the hash and size commit to. */
function bodyMatches(event: RelayEvent): boolean {
  if (event.body === null) {
    return event.bodyHash === ZERO_BODY_HASH && event.bodySize === 0;
  }
  try {
    if (canonicalizeJson(JSON.parse(event.body)) !== event.body) return false;
  } catch {
    return false;
  }
  const bytes = ethers.toUtf8Bytes(event.body);
  return (
    ethers.keccak256(bytes) === event.bodyHash &&
    bytes.length === event.bodySize
  );
}

/** The event's own checks against its grant (verify.rs `verify_event`). */
function eventProblem(event: RelayEvent, grant: RelayGrant): string | null {
  const scope = KIND_SCOPES[event.kind as DeviceEventKind];
  if (!scope) return 'unknown kind';
  if (event.kindVersion !== DEVICE_EVENT_KIND_VERSION) {
    return 'unknown kind version';
  }
  if (event.keyType !== DEVICE_EVENT_KEY_TYPE) return 'key type';
  if (
    !same(event.authRef, grant.id) ||
    !same(event.deviceKey, grant.deviceKey) ||
    !same(event.author, grant.wallet)
  ) {
    return 'not bound to its grant';
  }
  if (!grant.scopes.includes(scope)) return 'out of the grant scope';
  if (!HEX32.test(event.bodyHash) || !bodyMatches(event)) {
    return 'body does not match its hash';
  }
  let id: string;
  try {
    id = computeDeviceEventId({
      kind: event.kind,
      kindVersion: event.kindVersion,
      wave: event.wave,
      author: event.author,
      keyType: event.keyType,
      deviceKey: event.deviceKey,
      authRef: event.authRef,
      seq: event.seq,
      anchor: event.anchor,
      claimedTime: event.claimedTime,
      refs: event.refs,
      bodyHash: event.bodyHash,
      bodySize: event.bodySize
    });
  } catch {
    return 'fields out of range';
  }
  if (id !== event.id) return 'event id does not match';
  if (
    !verifyEd25519EventSignature({
      deviceKey: event.deviceKey,
      eventId: event.id,
      signature: event.signature
    })
  ) {
    return 'signature does not verify';
  }
  return null;
}

function scopesOf(text: string): string[] {
  return text.split(',').filter(Boolean);
}

/** The 6529 app hosts a sign-in grant may name (grant.rs APP_GRANT_DOMAINS). */
const APP_GRANT_DOMAINS = ['6529.io', 'staging.6529.io'];
/** The latest date a grant may name (wave-events time.rs MAX_DATE_SECONDS). */
const MAX_DATE_SECONDS = 8_640_000_000_000;
/** The longest grant (grant.rs MAX_GRANT_TTL_SECONDS). */
const MAX_GRANT_TTL_SECONDS = 181 * 24 * 60 * 60;
const SECP256K1_HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'
);

/**
 * The address an ordinary wallet's signature over `digest` recovers to, as
 * wave-events' eth.rs `recover_prehash` reads it: exactly 65 bytes, v of
 * 0, 1, 27 or 28, a low s. Null for anything else.
 */
function recoverStrict(digest: string, signature: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const v = parseInt(signature.slice(130, 132), 16);
  if (![0, 1, 27, 28].includes(v)) return null;
  if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return null;
  try {
    return ethers
      .recoverAddress(digest, {
        r: `0x${signature.slice(2, 66)}`,
        s: `0x${signature.slice(66, 130)}`,
        v: v < 27 ? v + 27 : v
      })
      .toLowerCase();
  } catch {
    return null;
  }
}

/** Scopes as the message wrote them, in its order. */
function scopesInOrder(text: string, separator: string): string[] {
  return text.split(separator);
}

export type GrantCheck = 'verified' | 'unverifiable';

/**
 * The grant's terms against the message its wallet signed (verify.rs
 * `grant_consistent`), then the wallet's signature over it (`check_grant`):
 * the check, or the problem. A signature that recovers to no one on a
 * mainnet grant may be a contract wallet's (EIP-1271), which only Ethereum
 * can check: `unverifiable`, as wave-events calls it.
 */
function checkGrantProof(grant: RelayGrant): GrantCheck | string {
  // wave-events takes any hex signature (a wrong length is unverifiable)
  // and refuses anything else.
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(grant.walletSignature)) {
    return 'grant signature';
  }
  let digest: string;
  if (grant.message.startsWith('{')) {
    // wave-events reads the message's wallet in any case; ethers wants a
    // valid checksum or none, so the address goes in lowercase.
    const raw = JSON.parse(grant.message) as {
      scopes?: unknown;
      wallet?: unknown;
    };
    const parsed = parseAppDeviceGrantMessage(
      typeof raw.wallet === 'string'
        ? JSON.stringify({ ...raw, wallet: raw.wallet.toLowerCase() })
        : grant.message
    );
    if (!parsed) return 'grant message unreadable';
    const { grant: terms, message } = parsed;
    if (
      typeof raw.scopes !== 'string' ||
      scopesInOrder(raw.scopes, ',').join(',') !== terms.scopes.join(',') ||
      terms.issued_at <= 0 ||
      terms.expires_at % 60 !== 0 ||
      terms.expires_at <= terms.issued_at ||
      terms.expires_at > MAX_DATE_SECONDS ||
      terms.expires_at - terms.issued_at > MAX_GRANT_TTL_SECONDS
    ) {
      return 'grant terms out of bounds';
    }
    digest = computeAppDeviceGrantId(message);
    if (
      digest !== grant.id ||
      terms.origin !== grant.domain ||
      grant.chainId !== 1 ||
      !same(terms.wallet, grant.wallet) ||
      !same(terms.device_key, grant.deviceKey) ||
      terms.scopes.join(',') !== grant.scopes.join(',') ||
      terms.expires_at * 1000 !== grant.expiresAt
    ) {
      return 'grant inconsistent';
    }
  } else {
    digest = computeDeviceGrantId(grant.message);
    if (digest !== grant.id) return 'grant inconsistent';
    const parsed = parseSiweWebAuthMessage(grant.message);
    const terms = parsed?.deviceGrant;
    if (
      !parsed ||
      !terms ||
      !APP_GRANT_DOMAINS.includes(parsed.domain) ||
      !same(parsed.domain, grant.domain) ||
      parsed.chainId !== grant.chainId ||
      !same(parsed.address, grant.wallet) ||
      !same(terms.deviceKey, grant.deviceKey) ||
      terms.scopes.join(',') !== grant.scopes.join(',') ||
      terms.expiresAtSeconds * 1000 !== grant.expiresAt
    ) {
      return 'grant inconsistent';
    }
  }
  const signer = recoverStrict(digest, grant.walletSignature);
  if (signer && same(signer, grant.wallet)) return 'verified';
  return grant.chainId === 1 ? 'unverifiable' : 'grant signature';
}

/** A grant 6529.io holds, against the proof the event came with. */
function knownGrantProblem(
  grant: RelayGrant,
  known: DeviceGrantEntity
): string | null {
  return same(known.wallet, grant.wallet) &&
    same(known.device_key, grant.deviceKey) &&
    scopesOf(known.scopes).join(',') === grant.scopes.join(',') &&
    Number(known.expires_at) === grant.expiresAt
    ? null
    : 'grant differs from the one 6529.io holds';
}

/**
 * Checks one relay item. `known` is the grant 6529.io holds under the
 * event's grant id, if any; its revocation counts as well as the proof's.
 */
/** Grant checks already made in a run, by the whole grant proof. */
export type GrantCheckCache = Map<string, GrantCheck | string>;

export function checkRelayEvent(
  rawEvent: Record<string, unknown>,
  rawGrant: Record<string, unknown>,
  known: DeviceGrantEntity | null,
  cache?: GrantCheckCache
): RelayEventCheck {
  try {
    return check(rawEvent, rawGrant, known, cache);
  } catch (error) {
    // Whatever a frame holds, a check answers; it never stops the reader.
    return {
      ok: false,
      reason:
        `unreadable (${error instanceof Error ? error.message : String(error)})`.slice(
          0,
          200
        )
    };
  }
}

function check(
  rawEvent: Record<string, unknown>,
  rawGrant: Record<string, unknown>,
  known: DeviceGrantEntity | null,
  cache?: GrantCheckCache
): RelayEventCheck {
  const event = readRelayEvent(rawEvent);
  if (typeof event === 'string') return { ok: false, reason: event };
  const grant = readRelayGrant(rawGrant);
  if (typeof grant === 'string') return { ok: false, reason: grant };
  const size = sizeProblem(event);
  if (size) return { ok: false, reason: size };
  const problem = eventProblem(event, grant);
  if (problem) return { ok: false, reason: problem };
  const cacheKey = JSON.stringify(grant);
  const proof = cache?.get(cacheKey) ?? checkGrantProof(grant);
  cache?.set(cacheKey, proof);
  if (proof !== 'verified' && proof !== 'unverifiable') {
    return { ok: false, reason: proof };
  }
  if (known) {
    const differs = knownGrantProblem(grant, known);
    if (differs) return { ok: false, reason: differs };
  }
  if (event.claimedTime >= grant.expiresAt) {
    return { ok: false, reason: 'grant expired' };
  }
  const revokedAt = [grant.revokedAt, known?.revoked_at ?? null]
    .filter((at): at is number => at !== null && at !== undefined)
    .map(Number);
  if (revokedAt.some((at) => event.claimedTime > at)) {
    return { ok: false, reason: 'grant revoked' };
  }
  return {
    ok: true,
    event,
    grant,
    // A contract wallet's grant 6529.io verified when it was registered.
    grantVia: known
      ? 'known'
      : proof === 'verified'
        ? 'signature'
        : 'unverifiable'
  };
}
