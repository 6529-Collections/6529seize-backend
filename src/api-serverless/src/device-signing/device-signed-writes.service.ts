import * as Joi from 'joi';
import { AuthenticationContext } from '@/auth-context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { ApiCompliantException, NotFoundException } from '@/exceptions';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  DeviceGrantScope,
  deserializeDeviceGrantScopes
} from './device-grant-message';
import {
  canonicalizeEventBody,
  CanonicalEventBody,
  computeDeviceEventId,
  DEVICE_EVENT_ANCHOR,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind,
  verifyEd25519EventSignature
} from './device-event';
import { DeviceSigningDb, deviceSigningDb } from './device-signing.db';

export const DEVICE_SIGNATURE_FIELD = 'device_signature';
export const DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
export const INVALID_DEVICE_SIGNATURE_PREFIX = 'Invalid device signature:';

export class InvalidDeviceSignatureException extends ApiCompliantException {
  constructor(reason: string) {
    super(
      `${INVALID_DEVICE_SIGNATURE_PREFIX} ${reason}`,
      'INVALID_DEVICE_SIGNATURE'
    );
  }

  getStatusCode(): number {
    return 400;
  }
}

export interface DeviceSignatureEnvelope {
  readonly grant_id: string;
  readonly seq: number;
  readonly claimed_time: number;
  readonly signature: string;
}

const DeviceSignatureEnvelopeSchema: Joi.ObjectSchema<DeviceSignatureEnvelope> =
  Joi.object<DeviceSignatureEnvelope>({
    grant_id: Joi.string()
      .pattern(/^0x[0-9a-f]{64}$/)
      .required(),
    seq: Joi.number()
      .integer()
      .strict()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .required(),
    claimed_time: Joi.number()
      .integer()
      .strict()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .required(),
    signature: Joi.string()
      .pattern(/^0x[0-9a-f]{128}$/)
      .required()
  })
    .required()
    .unknown(false);

const KIND_SCOPES: Record<DeviceEventKind, DeviceGrantScope> = {
  [DeviceEventKind.POST]: 'post',
  [DeviceEventKind.EDIT]: 'edit',
  [DeviceEventKind.TOMBSTONE]: 'delete',
  [DeviceEventKind.REACT]: 'react'
};

type AuthorSignatureEffect = 'none' | 'set' | 'clear';

// What a successful write does to drop_author_signatures.
const SIGNED_AUTHOR_SIGNATURE_EFFECT: Record<
  DeviceEventKind,
  AuthorSignatureEffect
> = {
  [DeviceEventKind.POST]: 'set',
  [DeviceEventKind.EDIT]: 'set',
  [DeviceEventKind.TOMBSTONE]: 'clear',
  [DeviceEventKind.REACT]: 'none'
};

const UNSIGNED_AUTHOR_SIGNATURE_EFFECT: Record<
  DeviceEventKind,
  AuthorSignatureEffect
> = {
  [DeviceEventKind.POST]: 'none',
  [DeviceEventKind.EDIT]: 'clear',
  [DeviceEventKind.TOMBSTONE]: 'clear',
  [DeviceEventKind.REACT]: 'none'
};

export type SignedWriteContext = RequestContext & {
  readonly authenticationContext: AuthenticationContext;
};

export interface SignedWriteTarget {
  readonly kind: DeviceEventKind;
  readonly waveId: string;
  readonly refs: readonly string[];
  // Value that is canonicalized and hashed; null when the event has no body.
  readonly body: unknown;
}

export interface ReservedDeviceEvent {
  readonly eventId: string;
  readonly grantId: string;
  readonly kind: DeviceEventKind;
  // Server receive time; orders concurrent signed writes on one drop.
  readonly receivedAt: number;
}

export interface StrippedDeviceSignature<T> {
  readonly body: T;
  // undefined when the request carried no device_signature member.
  readonly envelope: unknown;
}

/**
 * Removes device_signature from a parsed request body. The returned body is
 * exactly what the device key signed and what the existing write logic sees.
 */
export function stripDeviceSignature<T>(body: T): StrippedDeviceSignature<T> {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    !(DEVICE_SIGNATURE_FIELD in body)
  ) {
    return { body, envelope: undefined };
  }
  const { [DEVICE_SIGNATURE_FIELD]: envelope, ...rest } = body as Record<
    string,
    unknown
  >;
  return { body: rest as T, envelope };
}

function buildEventRow({
  eventId,
  target,
  grant,
  envelope,
  body,
  profileId,
  receivedAt
}: {
  readonly eventId: string;
  readonly target: SignedWriteTarget;
  readonly grant: DeviceGrantEntity;
  readonly envelope: DeviceSignatureEnvelope;
  readonly body: CanonicalEventBody;
  readonly profileId: string;
  readonly receivedAt: number;
}): DeviceSignedEventEntity {
  return {
    id: eventId,
    kind: target.kind,
    kind_version: DEVICE_EVENT_KIND_VERSION,
    wave_id: target.waveId,
    drop_id: null,
    author: grant.wallet,
    profile_id: profileId,
    key_type: DEVICE_EVENT_KEY_TYPE,
    device_key: grant.device_key,
    grant_id: grant.id,
    seq: envelope.seq,
    anchor: DEVICE_EVENT_ANCHOR,
    claimed_time: envelope.claimed_time,
    refs: JSON.stringify(target.refs),
    body: body.canonical,
    body_hash: body.bodyHash,
    body_size: body.bodySize,
    signature: envelope.signature,
    created_at: receivedAt
  };
}

export class DeviceSignedWritesService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly db: DeviceSigningDb,
    private readonly identities: IdentitiesDb,
    private readonly drops: DropsDb,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** POST /drops: the wave and reply target come from the request. */
  async createDrop<T extends { readonly id: string }>(
    {
      envelope,
      waveId,
      replyToDropId,
      body
    }: {
      readonly envelope: unknown;
      readonly waveId: string;
      readonly replyToDropId: string | null | undefined;
      readonly body: unknown;
    },
    write: () => Promise<T>,
    ctx: SignedWriteContext
  ): Promise<T> {
    if (envelope === undefined) {
      return write();
    }
    const reservation = await this.verifyAndReserve(
      envelope,
      {
        kind: DeviceEventKind.POST,
        waveId,
        refs: replyToDropId ? [replyToDropId] : [],
        body
      },
      ctx
    );
    return this.runReserved(reservation, write, (created) => created.id, ctx);
  }

  /**
   * Edit, delete and reaction writes on an existing drop. The wave is the
   * drop's stored wave; pass it when the caller already loaded it.
   */
  async mutateDrop<T>(
    {
      envelope,
      kind,
      dropId,
      waveId,
      body
    }: {
      readonly envelope: unknown;
      readonly kind: Exclude<DeviceEventKind, DeviceEventKind.POST>;
      readonly dropId: string;
      readonly waveId?: string;
      readonly body: unknown;
    },
    write: () => Promise<T>,
    ctx: SignedWriteContext
  ): Promise<T> {
    if (envelope === undefined) {
      return this.runUnsigned(kind, dropId, write, ctx);
    }
    const storedWaveId =
      waveId ?? (await this.drops.findWaveIdByDropId(dropId, ctx));
    if (!storedWaveId) {
      if (kind === DeviceEventKind.TOMBSTONE) {
        // Deleting a missing drop is a no-op today; nothing to sign or store.
        return write();
      }
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const reservation = await this.verifyAndReserve(
      envelope,
      { kind, waveId: storedWaveId, refs: [dropId], body },
      ctx
    );
    if (SIGNED_AUTHOR_SIGNATURE_EFFECT[kind] !== 'none') {
      // Fail safe: if finalize later fails, the drop reads as not author
      // signed instead of pointing at an event for older content.
      await this.clearAuthorSignatureBestEffort(dropId, ctx);
    }
    return this.runReserved(reservation, write, () => dropId, ctx);
  }

  /**
   * Steps 1-7 of the signed write check. Throws
   * InvalidDeviceSignatureException on any failure; on success the event row
   * is reserved and must be finalized or released by the caller.
   */
  async verifyAndReserve(
    rawEnvelope: unknown,
    target: SignedWriteTarget,
    ctx: SignedWriteContext
  ): Promise<ReservedDeviceEvent> {
    const envelope = this.validateEnvelope(rawEnvelope);
    const { authenticationContext } = ctx;
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new InvalidDeviceSignatureException(
        'not available when acting as a proxy'
      );
    }
    const now = this.now();
    const grant = await this.loadUsableGrant(
      envelope.grant_id,
      target,
      now,
      ctx
    );
    const profileId = await this.assertGrantWalletIsActingProfile(
      grant,
      authenticationContext
    );
    if (
      Math.abs(envelope.claimed_time - now) > DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS
    ) {
      throw new InvalidDeviceSignatureException(
        'claimed_time is more than 10 minutes from server time'
      );
    }
    const body = this.canonicalizeBody(target.body);
    const eventId = computeDeviceEventId({
      kind: target.kind,
      kindVersion: DEVICE_EVENT_KIND_VERSION,
      wave: target.waveId,
      author: grant.wallet,
      keyType: DEVICE_EVENT_KEY_TYPE,
      deviceKey: grant.device_key,
      authRef: grant.id,
      seq: envelope.seq,
      anchor: DEVICE_EVENT_ANCHOR,
      claimedTime: envelope.claimed_time,
      refs: target.refs,
      bodyHash: body.bodyHash,
      bodySize: body.bodySize
    });
    if (
      !verifyEd25519EventSignature({
        deviceKey: grant.device_key,
        eventId,
        signature: envelope.signature
      })
    ) {
      throw new InvalidDeviceSignatureException('signature does not verify');
    }
    const event = buildEventRow({
      eventId,
      target,
      grant,
      envelope,
      body,
      profileId,
      receivedAt: now
    });
    if (!(await this.db.reserveEvent(event, ctx))) {
      throw new InvalidDeviceSignatureException(
        'event or sequence number was already used'
      );
    }
    return {
      eventId,
      grantId: grant.id,
      kind: target.kind,
      receivedAt: now
    };
  }

  private validateEnvelope(rawEnvelope: unknown): DeviceSignatureEnvelope {
    const { error, value } =
      DeviceSignatureEnvelopeSchema.validate(rawEnvelope);
    if (error) {
      throw new InvalidDeviceSignatureException(
        `malformed envelope (${error.message})`
      );
    }
    return value;
  }

  private async loadUsableGrant(
    grantId: string,
    target: SignedWriteTarget,
    now: number,
    ctx: RequestContext
  ): Promise<DeviceGrantEntity> {
    const grant = await this.db.findGrantById(grantId, { timer: ctx.timer });
    if (!grant) {
      throw new InvalidDeviceSignatureException('unknown grant');
    }
    if (grant.revoked_at !== null) {
      throw new InvalidDeviceSignatureException('grant was revoked');
    }
    if (Number(grant.expires_at) <= now) {
      throw new InvalidDeviceSignatureException('grant expired');
    }
    const scope = KIND_SCOPES[target.kind];
    if (!deserializeDeviceGrantScopes(grant.scopes).includes(scope)) {
      throw new InvalidDeviceSignatureException(
        `grant does not include the ${scope} scope`
      );
    }
    return grant;
  }

  private async assertGrantWalletIsActingProfile(
    grant: DeviceGrantEntity,
    authenticationContext: AuthenticationContext
  ): Promise<string> {
    const actingProfileId = authenticationContext.getActingAsId();
    const grantProfileId = actingProfileId
      ? await this.identities.getProfileIdByWallet(grant.wallet)
      : null;
    if (!actingProfileId || grantProfileId !== actingProfileId) {
      throw new InvalidDeviceSignatureException(
        'grant wallet does not belong to the acting profile'
      );
    }
    return actingProfileId;
  }

  private canonicalizeBody(body: unknown): CanonicalEventBody {
    try {
      return canonicalizeEventBody(body);
    } catch {
      throw new InvalidDeviceSignatureException('body cannot be canonicalized');
    }
  }

  private async runReserved<T>(
    reservation: ReservedDeviceEvent,
    write: () => Promise<T>,
    dropIdOf: (result: T) => string,
    ctx: RequestContext
  ): Promise<T> {
    let result: T;
    try {
      result = await write();
    } catch (error) {
      await this.releaseReservation(reservation, ctx);
      throw error;
    }
    await this.finalize(reservation, dropIdOf(result), ctx);
    return result;
  }

  private async runUnsigned<T>(
    kind: DeviceEventKind,
    dropId: string,
    write: () => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const clearsSignature = UNSIGNED_AUTHOR_SIGNATURE_EFFECT[kind] === 'clear';
    if (clearsSignature && kind === DeviceEventKind.EDIT) {
      // Never let a failed clear leave edited content marked as author signed.
      await this.clearAuthorSignatureBestEffort(dropId, ctx);
    }
    const result = await write();
    if (clearsSignature) {
      await this.clearAuthorSignatureBestEffort(dropId, ctx);
    }
    return result;
  }

  private async releaseReservation(
    reservation: ReservedDeviceEvent,
    ctx: RequestContext
  ): Promise<void> {
    try {
      await this.db.deleteReservedEvent(reservation.eventId, {
        timer: ctx.timer
      });
    } catch (error) {
      this.logger.error(
        `Failed to release device signed event ${reservation.eventId}`,
        error
      );
    }
  }

  private async finalize(
    reservation: ReservedDeviceEvent,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const effect = SIGNED_AUTHOR_SIGNATURE_EFFECT[reservation.kind];
    const now = this.now();
    try {
      await this.db.executeNativeQueriesInTransaction(async (connection) => {
        const txCtx: RequestContext = { timer: ctx.timer, connection };
        await this.db.attachEventToDrop(
          { eventId: reservation.eventId, dropId },
          txCtx
        );
        if (effect === 'set') {
          await this.db.upsertDropAuthorSignature(
            {
              dropId,
              eventId: reservation.eventId,
              signedAt: reservation.receivedAt
            },
            txCtx
          );
        } else if (effect === 'clear') {
          await this.db.deleteDropAuthorSignature(dropId, txCtx);
        }
        await this.db.touchGrantLastUsed(reservation.grantId, now, txCtx);
      });
    } catch (error) {
      this.logger.error(
        `Failed to finalize device signed event ${reservation.eventId} for drop ${dropId}`,
        error
      );
    }
  }

  private async clearAuthorSignatureBestEffort(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      await this.db.deleteDropAuthorSignature(dropId, { timer: ctx.timer });
    } catch (error) {
      this.logger.error(
        `Failed to clear author signature status of drop ${dropId}`,
        error
      );
    }
  }
}

export const deviceSignedWritesService = new DeviceSignedWritesService(
  deviceSigningDb,
  identitiesDb,
  dropsDb
);
