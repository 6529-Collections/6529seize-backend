import { verifyEd25519EventSignature } from '@/api/device-signing/device-event';
import { ethers } from 'ethers';
import {
  computeRecordEventId,
  hashCanonicalBody,
  SignedRecordEvent,
  SignedRecordEventSchema
} from './record-event';
import {
  isKindAllowedInFamily,
  isOrdererFamily,
  isPrincipalFamily,
  isWalletAddress,
  parseFamilyWave,
  RecordFamily
} from './record-families';
import {
  isWellFormed,
  ParsedRecordBody,
  parseRecordBody,
  RecordBodyError
} from './record-body';
import { isRecordKind, RECORD_GRANT_SCOPE, RecordKind } from './record-kinds';
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
  /**
   * Wallets of the orderer role (the relays' config): they may write into
   * `pv` and `bk` and the lane families, for items they author.
   */
  readonly ordererWallets?: readonly string[];
}

export interface VerifiedRecord {
  readonly event: SignedRecordEvent;
  readonly family: RecordFamily;
  readonly owner: string;
  // The author wallet's principal at the anchor: the owner for ps, pv and bk,
  // unless the orderer wrote it or the owner is a bare wallet.
  readonly principal: string | null;
  // 'orderer' when the orderer role wrote it, else 'author'.
  readonly writer: 'author' | 'orderer';
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
  const strings = [value.wave, ...value.refs, value.body ?? ''];
  if (!strings.every(isWellFormed)) {
    throw new RecordReject('shape', 'a string is not well-formed Unicode');
  }
  return value;
}

function checkFamily(event: SignedRecordEvent, parsed: ParsedRecordBody) {
  const stream = parseFamilyWave(event.wave);
  if (!stream) {
    throw new RecordReject('family', 'wave is not a record stream');
  }
  const recordType = parsed.kind === RecordKind.RECORD ? parsed.type : null;
  if (!isKindAllowedInFamily(stream.family, event.kind, recordType)) {
    throw new RecordReject(
      'family',
      `${stream.family} does not carry kind ${event.kind} ${recordType ?? ''}`.trim()
    );
  }
  if (
    parsed.kind === RecordKind.RECORD &&
    parsed.type === 'reader' &&
    !isWalletAddress(parsed.key)
  ) {
    throw new RecordReject('refs', 'a reader record names a wallet');
  }
  return stream;
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
  // submission needs a grant that is not revoked at all. Replay judges by
  // the author's claimed time, as the relays do, so someone holding a
  // revoked key could backdate a record to before the revocation. Native
  // anchors bound that from below (P33 3.6). This is as designed.
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

/**
 * Who may write: for ps, pv and bk, the author bound to the owner at the
 * anchor; for pv and bk also the orderer role; for a ps stream owned by a
 * bare wallet, that wallet while it is bound to no principal. The other
 * families' writers are the lanes' rule; the orderer is named either way.
 */
function checkWriter(
  event: SignedRecordEvent,
  stream: { readonly family: RecordFamily; readonly owner: string },
  principal: string | null,
  ctx: RecordVerifyContext
): 'author' | 'orderer' {
  const orderer =
    isOrdererFamily(stream.family) &&
    (ctx.ordererWallets ?? []).some(
      (wallet) => wallet.toLowerCase() === event.author
    );
  if (!isPrincipalFamily(stream.family)) {
    return orderer ? 'orderer' : 'author';
  }
  if (isWalletAddress(stream.owner)) {
    if (event.author === stream.owner && principal === null) {
      return 'author';
    }
    throw new RecordReject(
      'not-bound',
      'only the owner wallet, bound to no principal, writes its stream'
    );
  }
  if (principal === stream.owner) {
    return 'author';
  }
  if (orderer) {
    return 'orderer';
  }
  throw new RecordReject(
    'not-bound',
    'author wallet is not bound to the stream owner at the anchor'
  );
}

async function verify(
  raw: unknown,
  ctx: RecordVerifyContext
): Promise<VerifiedRecord> {
  const event = checkShape(raw);
  if (!parseFamilyWave(event.wave)) {
    throw new RecordReject('family', 'wave is not a record stream');
  }
  const parsed = checkBody(event);
  const stream = checkFamily(event, parsed);
  checkSignature(event);
  await checkGrant(event, ctx);
  checkAnchor(event, ctx);
  const principal = await ctx.bindings.principalAt(event.author, event.anchor);
  return {
    event,
    family: stream.family,
    owner: stream.owner,
    principal,
    writer: checkWriter(event, stream, principal, ctx),
    order: orderKeyOf(event),
    parsed
  };
}

/**
 * Verifies a signed record: shape (well-formed strings), stream, body
 * against its kind, the kinds its family carries, event id, Ed25519
 * signature, grant (key, wallet, `post` scope, expiry, revocation), anchor
 * and writer (checkWriter). Never throws for a bad record; throws only when
 * a grant or binding source fails.
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
