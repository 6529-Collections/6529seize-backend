import { verifyEd25519EventSignature } from '@/api/device-signing/device-event';
import { ethers } from 'ethers';
import {
  computeRecordEventId,
  hashCanonicalBody,
  SignedRecordEvent,
  SignedRecordEventSchema
} from './record-event';
import {
  isPrincipalFamily,
  parseFamilyWave,
  RecordFamily
} from './record-families';
import {
  ParsedRecordBody,
  parseRecordBody,
  RecordBodyError
} from './record-body';
import { isRecordKind, RECORD_GRANT_SCOPE } from './record-kinds';
import { orderKeyOf, RecordOrderKey } from './record-order';

export type RecordRejectReason =
  | 'shape'
  | 'kind'
  | 'family'
  | 'refs'
  | 'body'
  | 'size'
  | 'id'
  | 'sig'
  | 'grant-unknown'
  | 'grant-scope'
  | 'grant-key'
  | 'grant-expired'
  | 'grant-revoked'
  | 'not-bound'
  | 'anchor';

export interface VerifiedGrant {
  readonly id: string;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly scopes: readonly string[];
  // Milliseconds.
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface RecordGrantSource {
  findGrant(grantId: string): Promise<VerifiedGrant | null>;
}

export interface PrincipalBindingSource {
  /** The principal the wallet was bound to at this finalized height, or null. */
  principalAt(wallet: string, height: number): Promise<string | null>;
}

/** Checks that apply only to a record submitted now, not one replayed later. */
export interface LiveRecordWindow {
  // Milliseconds.
  readonly now: number;
  // The current finalized height and how far behind it an anchor may be.
  readonly head: number;
  readonly maxAnchorLag: number;
  readonly maxClockSkewMs: number;
}

export interface RecordVerifyContext {
  readonly grants: RecordGrantSource;
  readonly bindings: PrincipalBindingSource;
  readonly live?: LiveRecordWindow;
}

export interface VerifiedRecord {
  readonly event: SignedRecordEvent;
  readonly family: RecordFamily;
  readonly owner: string;
  // The author wallet's principal at the anchor; the owner for ps, pv, bk.
  readonly principal: string | null;
  readonly order: RecordOrderKey;
  readonly parsed: ParsedRecordBody;
}

export type RecordVerifyResult =
  | { readonly ok: true; readonly record: VerifiedRecord }
  | {
      readonly ok: false;
      readonly reason: RecordRejectReason;
      readonly detail: string;
    };

class RecordReject extends Error {
  constructor(
    readonly reason: RecordRejectReason,
    detail: string
  ) {
    super(detail);
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, RecordReject.prototype);
  }
}

function checkShape(event: unknown): SignedRecordEvent {
  const kind = (event as { kind?: unknown } | null)?.kind;
  if (typeof kind === 'number' && !isRecordKind(kind)) {
    throw new RecordReject('kind', `kind ${kind} is not a record kind`);
  }
  const { error, value } = SignedRecordEventSchema.validate(event);
  if (error) {
    throw new RecordReject('shape', error.message);
  }
  return value;
}

function checkBody(event: SignedRecordEvent): ParsedRecordBody {
  let parsed: ParsedRecordBody;
  try {
    parsed = parseRecordBody(event);
  } catch (error) {
    if (error instanceof RecordBodyError) {
      throw new RecordReject(error.reason, error.message);
    }
    throw error;
  }
  const hashed =
    event.body === null
      ? { bodyHash: ethers.ZeroHash, bodySize: 0 }
      : hashCanonicalBody(event.body);
  if (
    hashed.bodyHash !== event.body_hash ||
    hashed.bodySize !== event.body_size
  ) {
    throw new RecordReject('body', 'body hash or size does not match');
  }
  return parsed;
}

function checkSignature(event: SignedRecordEvent): void {
  if (computeRecordEventId(event) !== event.id) {
    throw new RecordReject('id', 'event id does not match the fields');
  }
  if (
    !verifyEd25519EventSignature({
      deviceKey: event.device_key,
      eventId: event.id,
      signature: event.signature
    })
  ) {
    throw new RecordReject('sig', 'signature does not verify');
  }
}

async function checkGrant(
  event: SignedRecordEvent,
  ctx: RecordVerifyContext
): Promise<void> {
  const grant = await ctx.grants.findGrant(event.auth_ref);
  if (!grant) {
    throw new RecordReject('grant-unknown', 'unknown grant');
  }
  if (
    grant.deviceKey.toLowerCase() !== event.device_key ||
    grant.wallet.toLowerCase() !== event.author
  ) {
    throw new RecordReject('grant-key', 'grant names another key or wallet');
  }
  if (!grant.scopes.includes(RECORD_GRANT_SCOPE)) {
    throw new RecordReject('grant-scope', 'grant lacks the post scope');
  }
  const at = ctx.live?.now ?? event.claimed_time;
  if (at >= grant.expiresAt) {
    throw new RecordReject('grant-expired', 'grant expired');
  }
  // A record signed before a revocation stays valid when replayed; a live
  // submission needs a grant that is not revoked at all.
  const revoked =
    grant.revokedAt !== null &&
    (ctx.live !== undefined || event.claimed_time > grant.revokedAt);
  if (revoked) {
    throw new RecordReject('grant-revoked', 'grant was revoked');
  }
}

function checkAnchor(event: SignedRecordEvent, ctx: RecordVerifyContext) {
  if (event.anchor <= 0) {
    throw new RecordReject('anchor', 'anchor must be a finalized height');
  }
  const live = ctx.live;
  if (!live) {
    return;
  }
  if (
    event.anchor > live.head ||
    event.anchor < live.head - live.maxAnchorLag
  ) {
    throw new RecordReject('anchor', 'anchor is not near the finalized head');
  }
  if (Math.abs(event.claimed_time - live.now) > live.maxClockSkewMs) {
    throw new RecordReject('anchor', 'claimed time is too far from now');
  }
}

async function verify(
  raw: unknown,
  ctx: RecordVerifyContext
): Promise<VerifiedRecord> {
  const event = checkShape(raw);
  const stream = parseFamilyWave(event.wave);
  if (!stream) {
    throw new RecordReject('family', 'wave is not a record stream');
  }
  const parsed = checkBody(event);
  checkSignature(event);
  await checkGrant(event, ctx);
  checkAnchor(event, ctx);
  const principal = await ctx.bindings.principalAt(event.author, event.anchor);
  if (isPrincipalFamily(stream.family) && principal !== stream.owner) {
    throw new RecordReject(
      'not-bound',
      'author wallet is not bound to the stream owner at the anchor'
    );
  }
  return {
    event,
    family: stream.family,
    owner: stream.owner,
    principal,
    order: orderKeyOf(event),
    parsed
  };
}

/**
 * Verifies a signed record: shape, stream, body against its kind, event id,
 * Ed25519 signature, grant (key, wallet, `post` scope, expiry, revocation),
 * anchor, and, for principal-owned streams, that the author wallet was
 * bound to the owner at the anchor. Never throws for a bad record.
 */
export async function verifyRecordEvent(
  event: unknown,
  ctx: RecordVerifyContext
): Promise<RecordVerifyResult> {
  try {
    return { ok: true, record: await verify(event, ctx) };
  } catch (error) {
    if (error instanceof RecordReject) {
      return { ok: false, reason: error.reason, detail: error.message };
    }
    throw error;
  }
}
