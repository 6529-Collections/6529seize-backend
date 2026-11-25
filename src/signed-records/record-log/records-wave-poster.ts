import { createHash, KeyObject, sign as signBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { AuthenticationContext } from '@/auth-context';
import {
  computeDeviceEventId,
  DEVICE_EVENT_ANCHOR,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind
} from '@/api/device-signing/device-event';
import type {
  DeviceSignatureEnvelope,
  DeviceSignedWritesService
} from '@/api/device-signing/device-signed-writes.service';
import type { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { RequestContext } from '@/request.context';
import { readRecordsWaveSetting } from '@/waves-scope/waves-scope';
import type { RecordsWavePoster } from './record-log.service';
import { deviceKeyOfSeed } from './service-device-key';

/** The 6529.io service identity that signs the records wave's drops. */
export interface ServiceIdentity {
  readonly waveId: string;
  readonly profileId: string;
  readonly wallet: string;
  readonly grantId: string;
  readonly deviceKey: string;
  readonly privateKey: KeyObject;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Reads the service identity from config: SIGNED_RECORDS_WAVE_ID,
 * SIGNED_RECORDS_SERVICE_PROFILE_ID, SIGNED_RECORDS_SERVICE_WALLET,
 * SIGNED_RECORDS_SERVICE_GRANT_ID and SIGNED_RECORDS_SERVICE_DEVICE_SEED
 * (the Ed25519 seed, 0x + 64 hex, a secret). Null when any is missing, and
 * when SIGNED_RECORDS_WAVE_ID is `none` (6529.io has no records wave), so
 * nothing is ever posted to a wave called "none".
 */
export function loadServiceIdentity(
  env: Readonly<Record<string, string | undefined>>
): ServiceIdentity | null {
  const records = readRecordsWaveSetting(env);
  const waveId = records.kind === 'id' ? records.id : null;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const grantId = env.SIGNED_RECORDS_SERVICE_GRANT_ID?.toLowerCase();
  const seed = env.SIGNED_RECORDS_SERVICE_DEVICE_SEED?.toLowerCase();
  if (!waveId || !profileId || !wallet || !grantId || !seed) {
    return null;
  }
  if (!ADDRESS.test(wallet) || !HEX32.test(grantId) || !HEX32.test(seed)) {
    throw new Error('Malformed signed records service identity');
  }
  const { deviceKey, privateKey } = deviceKeyOfSeed(seed);
  return { waveId, profileId, wallet, grantId, deviceKey, privateKey };
}

/** A UUID derived from the text, so a retried post returns the first drop. */
function clientDropIdOf(waveId: string, text: string): string {
  const hex = createHash('sha256')
    .update(`${waveId}\n${text}`, 'utf8')
    .digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-');
}

/**
 * Posts the record log's head and archive drops as signed drops of the
 * service identity, through the same signed-write path as anyone's drop,
 * so the drop and its device-signed event reach the relays as drops do.
 */
export class SignedServiceDropPoster implements RecordsWavePoster {
  private lastSeq = 0;

  constructor(
    private readonly identity: ServiceIdentity,
    private readonly deps: {
      readonly signedWrites: Pick<DeviceSignedWritesService, 'createDrop'>;
      readonly dropCreation: Pick<DropCreationApiService, 'createDrop'>;
      readonly now?: () => number;
    }
  ) {}

  /** The request body the device key signs: exactly what a client would POST. */
  buildRequest(text: string): ApiCreateDropRequest {
    return {
      wave_id: this.identity.waveId,
      client_drop_id: clientDropIdOf(this.identity.waveId, text),
      drop_type: ApiDropType.Chat,
      title: null,
      parts: [{ content: text, quoted_drop: null, media: [] }],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_groups: [],
      metadata: [],
      signature: null,
      hide_link_preview: true
    };
  }

  /** Signs the body as an interim POST event, as the browser signer does. */
  signRequest(request: ApiCreateDropRequest): DeviceSignatureEnvelope {
    const now = this.deps.now?.() ?? Date.now();
    this.lastSeq = Math.max(this.lastSeq + 1, now);
    const canonical = canonicalizeJson(request);
    const bytes = ethers.toUtf8Bytes(canonical);
    const eventId = computeDeviceEventId({
      kind: DeviceEventKind.POST,
      kindVersion: DEVICE_EVENT_KIND_VERSION,
      wave: request.wave_id,
      author: this.identity.wallet,
      keyType: DEVICE_EVENT_KEY_TYPE,
      deviceKey: this.identity.deviceKey,
      authRef: this.identity.grantId,
      seq: this.lastSeq,
      anchor: DEVICE_EVENT_ANCHOR,
      claimedTime: now,
      refs: [],
      bodyHash: ethers.keccak256(bytes),
      bodySize: bytes.length
    });
    const signature = signBytes(
      null,
      Buffer.from(eventId.slice(2), 'hex'),
      this.identity.privateKey
    ).toString('hex');
    return {
      grant_id: this.identity.grantId,
      seq: this.lastSeq,
      claimed_time: now,
      signature: `0x${signature}`
    };
  }

  async post(text: string, ctx: RequestContext): Promise<string> {
    const request = this.buildRequest(text);
    const envelope = this.signRequest(request);
    const authenticationContext = new AuthenticationContext({
      authenticatedWallet: this.identity.wallet,
      authenticatedProfileId: this.identity.profileId,
      roleProfileId: null,
      activeProxyActions: []
    });
    const signedCtx = { ...ctx, authenticationContext };
    const drop = await this.deps.signedWrites.createDrop(
      {
        envelope,
        waveId: request.wave_id,
        replyToDropId: null,
        body: request
      },
      () =>
        this.deps.dropCreation.createDrop(
          {
            createDropRequest: request,
            authorId: this.identity.profileId,
            representativeId: this.identity.profileId,
            hideLinkPreview: true
          },
          signedCtx
        ),
      signedCtx
    );
    return drop.id;
  }
}
