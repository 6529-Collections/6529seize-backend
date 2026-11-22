import { KeyObject } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import type { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import type { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import type { IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  computeAppDeviceGrantId,
  findAppDeviceGrantProblem,
  parseAppDeviceGrantMessage,
  recoversToAppGrantWallet,
  serializeAppDeviceGrantMessage
} from './app-device-grant';
import {
  BOT_DEVICE_KEYS_SETTING,
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyOf,
  signEventId
} from './bot-device-grant';
import {
  canonicalizeEventBody,
  computeDeviceEventId,
  DEVICE_EVENT_ANCHOR,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind
} from './device-event';
import {
  DEVICE_GRANT_KEY_TYPE,
  formatGrantExpiryDateUtc,
  serializeDeviceGrantScopes
} from './device-grant-message';
import type {
  DeviceSignatureEnvelope,
  DeviceSignedWritesService,
  SignedWriteTarget
} from './device-signed-writes.service';
import type { DeviceSigningDb } from './device-signing.db';

// Signs the drop writes of 6529.io's own bots with their device keys
// (bot-device-grant.ts), so they reach the 6529 relays like any signed
// write. A signed bot write takes the API's signed path: the same checks a
// client-signed write passes, then device_signed_events and
// drop_author_signatures. A bot without a usable key writes unsigned, as
// before (logged once), so FEATURE_WAVES_DEVICE_SIGNATURE_REQUIRED never
// stops a bot.

const BOT_DEVICE_LABEL = '6529.io bot';
// App grants are checked on Ethereum mainnet (device-grants.service.ts).
const APP_GRANT_CHAIN_ID = 1;
const RENEW_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
// A sequence number another process took first: sign again with the next.
const MAX_SIGN_ATTEMPTS = 3;
const INVALID_DEVICE_SIGNATURE_CODE = 'INVALID_DEVICE_SIGNATURE';
// verifyAndReserve's reason when the event id or (device key, seq) is taken.
const SEQUENCE_TAKEN_REASON = 'event or sequence number was already used';
const WALLET_SIGNATURE_PATTERN = /^0x([0-9a-f]{2})+$/;

/**
 * A bot's usable device key. The private key stays inside `sign`: it is no
 * field of this object, so logging or serializing the object never shows it.
 */
export class BotDeviceKey {
  readonly sign: (eventId: string) => string;

  constructor(
    readonly profileId: string,
    /** The grant as device_grants stores it. */
    readonly grant: DeviceGrantEntity,
    privateKey: KeyObject
  ) {
    this.sign = (eventId) => signEventId(privateKey, eventId);
  }
}

export interface ParsedBotDeviceKeys {
  readonly keys: ReadonlyMap<string, BotDeviceKey>;
  /** Why entries were left out, without key material. */
  readonly problems: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads WAVES_BOT_DEVICE_KEYS: a JSON object from bot profile id to
 * BotDeviceKeyEntry. An entry is used only when its grant is a signing-only
 * app grant for exactly its device key, signed by the grant wallet's own key.
 * Expiry is checked on every write, not here.
 */
export function parseBotDeviceKeys(
  raw: string | undefined,
  nowMs: number
): ParsedBotDeviceKeys {
  const keys = new Map<string, BotDeviceKey>();
  if (!raw?.trim()) {
    return { keys, problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { keys, problems: [`${BOT_DEVICE_KEYS_SETTING} is not JSON`] };
  }
  if (!isRecord(parsed)) {
    return {
      keys,
      problems: [`${BOT_DEVICE_KEYS_SETTING} is not an object of profile ids`]
    };
  }
  const problems: string[] = [];
  for (const [profileId, entry] of Object.entries(parsed)) {
    const read = readEntry(profileId, entry, nowMs);
    if (typeof read === 'string') {
      problems.push(`[PROFILE ${profileId}] ${read}`);
    } else {
      keys.set(profileId, read);
    }
  }
  return { keys, problems };
}

function readEntry(
  profileId: string,
  entry: unknown,
  nowMs: number
): BotDeviceKey | string {
  if (
    !isRecord(entry) ||
    typeof entry.device_seed !== 'string' ||
    typeof entry.grant_message !== 'string' ||
    typeof entry.grant_signature !== 'string'
  ) {
    return 'needs device_seed, grant_message and grant_signature';
  }
  let privateKey: KeyObject;
  try {
    privateKey = ed25519PrivateKeyFromSeed(entry.device_seed);
  } catch {
    return 'device_seed is not 0x and 64 lowercase hex digits';
  }
  const parsed = parseAppDeviceGrantMessage(entry.grant_message);
  if (!parsed) {
    return 'grant_message is not an app device grant';
  }
  const { grant, message } = parsed;
  const problem = findAppDeviceGrantProblem(grant, 0);
  if (problem) {
    return `grant_message: ${problem}`;
  }
  if (grant.mls_device_key !== null) {
    return 'the grant also grants an encrypted-messages key';
  }
  if (ed25519PublicKeyOf(privateKey) !== grant.device_key) {
    return "device_seed is not the grant's device key";
  }
  const signature = entry.grant_signature.toLowerCase();
  if (
    !WALLET_SIGNATURE_PATTERN.test(signature) ||
    !recoversToAppGrantWallet(message, signature)
  ) {
    return "grant_signature is not the grant wallet's own signature";
  }
  return new BotDeviceKey(
    profileId,
    {
      id: computeAppDeviceGrantId(message),
      wallet: grant.wallet,
      key_type: DEVICE_GRANT_KEY_TYPE,
      device_key: grant.device_key,
      scopes: serializeDeviceGrantScopes(grant.scopes),
      device_label: BOT_DEVICE_LABEL,
      domain: grant.origin,
      message: serializeAppDeviceGrantMessage(message),
      wallet_signature: signature,
      chain_id: APP_GRANT_CHAIN_ID,
      issued_at: grant.issued_at * 1000,
      expires_at: grant.expires_at * 1000,
      created_at: nowMs,
      revoked_at: null,
      last_used_at: null
    },
    privateKey
  );
}

/** A body exactly as it is sent and signed: plain JSON, no undefined. */
function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * A drop a bot writes through CreateOrUpdateDropUseCase, as the POST /drops
 * request body that would create it: what its signed event commits to.
 */
export function signedBodyOfDropModel(
  model: CreateOrUpdateDropModel
): Record<string, unknown> {
  return {
    wave_id: model.wave_id,
    title: model.title,
    drop_type: model.drop_type,
    reply_to: model.reply_to,
    parts: model.parts.map((part) => ({
      content: part.content,
      quoted_drop: part.quoted_drop,
      media: part.media.map(({ url, mime_type }) => ({ url, mime_type })),
      ...(part.attachments?.length
        ? {
            attachments: part.attachments.map(({ attachment_id }) => ({
              attachment_id
            }))
          }
        : {})
    })),
    referenced_nfts: model.referenced_nfts,
    mentioned_users: model.mentioned_users.map(({ handle }) => ({
      handle_in_content: handle
    })),
    mentioned_waves: model.mentioned_waves,
    mentioned_groups: model.mentioned_groups,
    metadata: model.metadata,
    signature: model.signature,
    ...(model.hide_link_preview === undefined
      ? {}
      : { hide_link_preview: model.hide_link_preview })
  };
}

export interface BotDeviceSignerDeps {
  readonly writes: Pick<DeviceSignedWritesService, 'createDrop' | 'mutateDrop'>;
  readonly grants: Pick<DeviceSigningDb, 'insertGrant'>;
  readonly identities: Pick<IdentitiesDb, 'getProfileIdByWallet'>;
}

// Loaded on first use, not at import: these modules reach most of the drops
// code, which the bots' own modules are part of.
async function loadDefaultDeps(): Promise<BotDeviceSignerDeps> {
  const [{ deviceSignedWritesService }, { deviceSigningDb }, { identitiesDb }] =
    await Promise.all([
      import('./device-signed-writes.service'),
      import('./device-signing.db'),
      import('@/identities/identities.db')
    ]);
  return {
    writes: deviceSignedWritesService,
    grants: deviceSigningDb,
    identities: identitiesDb
  };
}

type SignedWrite<T> = (
  writes: BotDeviceSignerDeps['writes'],
  envelope: DeviceSignatureEnvelope,
  botCtx: RequestContext & { authenticationContext: AuthenticationContext },
  write: () => Promise<T>
) => Promise<T>;

export class BotDeviceSigner {
  private readonly logger = Logger.get(this.constructor.name);
  private parsed: {
    readonly raw: string | undefined;
    readonly keys: ReadonlyMap<string, BotDeviceKey>;
  } | null = null;
  private readonly warned = new Set<string>();
  private readonly storedGrants = new Map<string, Promise<boolean>>();
  private deps: Promise<BotDeviceSignerDeps> | null = null;
  private lastSeq = 0;

  constructor(
    private readonly loadDeps: () => Promise<BotDeviceSignerDeps> = loadDefaultDeps,
    private readonly setting: () => string | undefined = () =>
      process.env[BOT_DEVICE_KEYS_SETTING],
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Posts a drop as a bot: signed when the bot has a usable device key,
   * unsigned as before when not. `body` is the POST /drops request body the
   * post commits to.
   */
  async createDrop<T extends { readonly id: string }>(
    botProfileId: string | null,
    {
      waveId,
      replyToDropId,
      body
    }: {
      readonly waveId: string;
      readonly replyToDropId: string | null;
      readonly body: unknown;
    },
    write: () => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const signedBody = toJsonValue(body);
    return this.signedOrUnsigned(
      botProfileId,
      {
        kind: DeviceEventKind.POST,
        waveId,
        refs: replyToDropId ? [replyToDropId] : [],
        body: signedBody
      },
      (writes, envelope, botCtx, tracked) =>
        writes.createDrop(
          { envelope, waveId, replyToDropId, body: signedBody },
          tracked,
          botCtx
        ),
      write,
      ctx
    );
  }

  /** An edit, delete or reaction by a bot, signed as createDrop is. */
  async mutateDrop<T>(
    botProfileId: string | null,
    {
      kind,
      dropId,
      waveId,
      body
    }: {
      readonly kind: Exclude<DeviceEventKind, DeviceEventKind.POST>;
      readonly dropId: string;
      readonly waveId: string;
      readonly body: unknown;
    },
    write: () => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const signedBody = toJsonValue(body);
    return this.signedOrUnsigned(
      botProfileId,
      { kind, waveId, refs: [dropId], body: signedBody },
      (writes, envelope, botCtx, tracked) =>
        writes.mutateDrop(
          { envelope, kind, dropId, waveId, body: signedBody },
          tracked,
          botCtx
        ),
      write,
      ctx
    );
  }

  /**
   * For a bot that writes through the HTTP API: the device_signature of a
   * request body (`target.body`, sent exactly as given), or undefined when
   * the bot writes unsigned.
   */
  async envelopeFor(
    botProfileId: string | null,
    target: SignedWriteTarget
  ): Promise<DeviceSignatureEnvelope | undefined> {
    const key = await this.usableKey(botProfileId);
    return key
      ? this.envelope(key, { ...target, body: toJsonValue(target.body) })
      : undefined;
  }

  /**
   * The profile of a bot known by its wallet. Null when no bot has a key
   * (without reading the database) or when the lookup fails (logged).
   */
  async profileIdOfWallet(wallet: string): Promise<string | null> {
    if (!this.keys().size) {
      return null;
    }
    try {
      const { identities } = await this.dependencies();
      return await identities.getProfileIdByWallet(wallet.toLowerCase());
    } catch (error) {
      this.logger.error(
        `[BOT DROPS UNSIGNED] [WALLET ${wallet}] the bot's profile could not be read: ${(error as Error)?.message ?? error}`
      );
      return null;
    }
  }

  private dependencies(): Promise<BotDeviceSignerDeps> {
    this.deps ??= this.loadDeps().catch((error) => {
      this.deps = null;
      throw error;
    });
    return this.deps;
  }

  private async signedOrUnsigned<T>(
    botProfileId: string | null,
    target: SignedWriteTarget,
    signedWrite: SignedWrite<T>,
    write: () => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const key = await this.usableKey(botProfileId);
    if (!key) {
      return write();
    }
    const { writes } = await this.dependencies();
    const botCtx = {
      timer: ctx.timer,
      authenticationContext: AuthenticationContext.fromProfileId(key.profileId)
    };
    for (let attempt = 1; ; attempt++) {
      let wrote = false;
      const tracked = () => {
        wrote = true;
        return write();
      };
      try {
        return await signedWrite(
          writes,
          this.envelope(key, target),
          botCtx,
          tracked
        );
      } catch (error) {
        // Only a refusal before the write ran is handled here.
        if (wrote || !isInvalidDeviceSignature(error)) {
          throw error;
        }
        if (isSequenceTaken(error) && attempt < MAX_SIGN_ATTEMPTS) {
          continue;
        }
        this.logger.error(
          `[BOT DROP WRITTEN UNSIGNED] [PROFILE ${key.profileId}] [GRANT ${key.grant.id}] [${(error as Error).message}]`
        );
        return write();
      }
    }
  }

  private async usableKey(
    botProfileId: string | null
  ): Promise<BotDeviceKey | null> {
    const key = this.keyOf(botProfileId);
    return key && (await this.ensureGrantStored(key)) ? key : null;
  }

  private keys(): ReadonlyMap<string, BotDeviceKey> {
    const raw = this.setting();
    if (!this.parsed || this.parsed.raw !== raw) {
      const { keys, problems } = parseBotDeviceKeys(raw, this.now());
      for (const problem of problems) {
        this.logger.error(`[BOT DEVICE KEY LEFT OUT] ${problem}`);
      }
      this.parsed = { raw, keys };
    }
    return this.parsed.keys;
  }

  private keyOf(botProfileId: string | null): BotDeviceKey | null {
    const keys = this.keys();
    if (!keys.size) {
      this.warnOnce(
        'none',
        `[BOT DROPS UNSIGNED] [${BOT_DEVICE_KEYS_SETTING} has no keys] 6529.io's bots write drops without a device signature, so their drops don't reach the 6529 relays`
      );
      return null;
    }
    const key = botProfileId === null ? undefined : keys.get(botProfileId);
    if (!key) {
      this.warnOnce(
        `profile ${botProfileId}`,
        `[BOT DROPS UNSIGNED] [PROFILE ${botProfileId ?? 'unknown'}] no device key in ${BOT_DEVICE_KEYS_SETTING}, so this bot's drops don't reach the 6529 relays`
      );
      return null;
    }
    const expiresAt = Number(key.grant.expires_at);
    const now = this.now();
    const expiry = formatGrantExpiryDateUtc(Math.floor(expiresAt / 1000));
    if (expiresAt <= now) {
      this.warnOnce(
        `expired ${key.grant.id}`,
        `[BOT DROPS UNSIGNED] [PROFILE ${key.profileId}] [GRANT ${key.grant.id}] the device grant expired on ${expiry}; make a new one with 6529 run waves:bot-device-grant`
      );
      return null;
    }
    if (expiresAt - now <= RENEW_WARNING_MS) {
      this.warnOnce(
        `renew ${key.grant.id}`,
        `[BOT DEVICE GRANT EXPIRING] [PROFILE ${key.profileId}] [GRANT ${key.grant.id}] the device grant expires on ${expiry}; make a new one with 6529 run waves:bot-device-grant`
      );
    }
    return key;
  }

  private warnOnce(topic: string, message: string): void {
    if (!this.warned.has(topic)) {
      this.warned.add(topic);
      this.logger.warn(message);
    }
  }

  /**
   * Stores the bot's grant in device_grants once per process, as a sign-in
   * stores a browser's, so a signed write and the relays find its proof.
   * Idempotent on the grant id: a grant stored or revoked earlier stays so.
   */
  private ensureGrantStored(key: BotDeviceKey): Promise<boolean> {
    let stored = this.storedGrants.get(key.grant.id);
    if (!stored) {
      stored = this.storeGrant(key);
      this.storedGrants.set(key.grant.id, stored);
    }
    return stored;
  }

  private async storeGrant(key: BotDeviceKey): Promise<boolean> {
    try {
      const { grants } = await this.dependencies();
      await grants.insertGrant(key.grant, {});
      return true;
    } catch (error) {
      this.storedGrants.delete(key.grant.id);
      this.logger.error(
        `[BOT DROPS UNSIGNED] [PROFILE ${key.profileId}] [GRANT ${key.grant.id}] the device grant could not be stored: ${(error as Error)?.message ?? error}`
      );
      return false;
    }
  }

  private envelope(
    key: BotDeviceKey,
    target: SignedWriteTarget
  ): DeviceSignatureEnvelope {
    const claimedTime = this.now();
    // As a browser picks it: never below the clock, never repeated here.
    this.lastSeq = Math.max(this.lastSeq + 1, claimedTime);
    const seq = this.lastSeq;
    const body = canonicalizeEventBody(target.body);
    const eventId = computeDeviceEventId({
      kind: target.kind,
      kindVersion: DEVICE_EVENT_KIND_VERSION,
      wave: target.waveId,
      author: key.grant.wallet,
      keyType: DEVICE_EVENT_KEY_TYPE,
      deviceKey: key.grant.device_key,
      authRef: key.grant.id,
      seq,
      anchor: DEVICE_EVENT_ANCHOR,
      claimedTime,
      refs: target.refs,
      bodyHash: body.bodyHash,
      bodySize: body.bodySize
    });
    return {
      grant_id: key.grant.id,
      seq,
      claimed_time: claimedTime,
      signature: key.sign(eventId)
    };
  }
}

function isInvalidDeviceSignature(error: unknown): boolean {
  return (
    (error as { readonly code?: unknown } | null)?.code ===
    INVALID_DEVICE_SIGNATURE_CODE
  );
}

function isSequenceTaken(error: unknown): boolean {
  return String((error as Error)?.message ?? '').endsWith(
    SEQUENCE_TAKEN_REASON
  );
}

export const botDeviceSigner = new BotDeviceSigner();
