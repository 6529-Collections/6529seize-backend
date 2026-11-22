import { Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  buildAppDeviceGrantMessage,
  serializeAppDeviceGrantMessage
} from '@/api/device-signing/app-device-grant';
import {
  BOT_GRANT_ORIGIN,
  BotDeviceKeyEntry,
  buildBotDeviceGrant
} from '@/api/device-signing/bot-device-grant';
import {
  BotDeviceSigner,
  BotDeviceSignerDeps
} from '@/api/device-signing/bot-device-signer';
import { DeviceSignedWritesService } from '@/api/device-signing/device-signed-writes.service';
import type { DeviceSigningDb } from '@/api/device-signing/device-signing.db';
import type { DropsDb } from '@/drops/drops.db';
import type { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import type { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import type { IdentitiesDb } from '@/identities/identities.db';

// Hardhat's first test account and the RFC 8032 test 1 seed (the shared DN1
// device key): public test values, never real keys.
export const TEST_BOT_WALLET_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const TEST_BOT_WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
export const TEST_BOT_DEVICE_SEED =
  '0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const TEST_BOT_DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
export const TEST_NOW = 1_792_324_900_000;

/** A WAVES_BOT_DEVICE_KEYS entry as the CLI makes it, for the test wallet. */
export async function testBotDeviceKeyEntry({
  issuedAt = new Date(TEST_NOW - 60_000),
  origin = BOT_GRANT_ORIGIN,
  walletKey = TEST_BOT_WALLET_KEY
}: {
  readonly issuedAt?: Date;
  readonly origin?: string;
  readonly walletKey?: string;
} = {}): Promise<BotDeviceKeyEntry> {
  const message = buildAppDeviceGrantMessage(
    buildBotDeviceGrant({
      wallet: TEST_BOT_WALLET,
      deviceKey: TEST_BOT_DEVICE_KEY,
      issuedAt,
      origin
    })
  );
  const signature = await new Wallet(walletKey).signTypedData(
    APP_DEVICE_GRANT_DOMAIN_V2,
    APP_DEVICE_GRANT_TYPES_V2,
    message
  );
  return {
    device_seed: TEST_BOT_DEVICE_SEED,
    grant_message: serializeAppDeviceGrantMessage(message),
    grant_signature: signature
  };
}

/** What the signed write path stored, as the database would hold it. */
export interface SigningBotStore {
  readonly grants: Map<string, DeviceGrantEntity>;
  readonly events: DeviceSignedEventEntity[];
  readonly authorSignatures: Map<string, string>;
  readonly released: string[];
  /** Reservations to refuse as taken before accepting again. */
  refuseReservations: number;
  /** Database calls that fail, by name (findGrantById, reserveEvent, ...). */
  readonly failing: Set<string>;
}

/**
 * A BotDeviceSigner over the real DeviceSignedWritesService, with in-memory
 * tables. `walletProfileId` is the profile the test wallet belongs to.
 */
export async function signingBot({
  profileId,
  walletProfileId = profileId,
  otherWallets = {},
  setting,
  now = () => TEST_NOW
}: {
  readonly profileId: string;
  readonly walletProfileId?: string | null;
  /** More wallets of known profiles, lower case. */
  readonly otherWallets?: Readonly<Record<string, string>>;
  /** WAVES_BOT_DEVICE_KEYS; by default one entry for `profileId`. */
  readonly setting?: string;
  readonly now?: () => number;
}): Promise<{
  readonly signer: BotDeviceSigner;
  readonly store: SigningBotStore;
  readonly setting: string;
  readonly deps: BotDeviceSignerDeps;
  /** The API's signed write path the signer uses. */
  readonly writes: DeviceSignedWritesService;
}> {
  const store: SigningBotStore = {
    grants: new Map(),
    events: [],
    authorSignatures: new Map(),
    released: [],
    refuseReservations: 0,
    failing: new Set()
  };
  const failIf = (name: string) => {
    if (store.failing.has(name)) {
      throw new Error(`${name}: database unavailable`);
    }
  };
  const db = {
    insertGrant: async (grant: DeviceGrantEntity) => {
      failIf('insertGrant');
      if (store.grants.has(grant.id)) {
        return false;
      }
      store.grants.set(grant.id, grant);
      return true;
    },
    findGrantById: async (id: string) => {
      failIf('findGrantById');
      return store.grants.get(id) ?? null;
    },
    reserveEvent: async (event: DeviceSignedEventEntity) => {
      failIf('reserveEvent');
      const taken = store.events.some(
        (it) =>
          it.id === event.id ||
          (it.device_key === event.device_key &&
            Number(it.seq) === Number(event.seq))
      );
      if (taken || store.refuseReservations > 0) {
        store.refuseReservations = Math.max(0, store.refuseReservations - 1);
        return false;
      }
      store.events.push({ ...event });
      return true;
    },
    deleteReservedEvent: async (id: string) => {
      store.released.push(id);
      const index = store.events.findIndex(
        (it) => it.id === id && it.drop_id === null
      );
      if (index >= 0) {
        store.events.splice(index, 1);
      }
    },
    attachEventToDrop: async ({
      eventId,
      dropId
    }: {
      eventId: string;
      dropId: string;
    }) => {
      const event = store.events.find((it) => it.id === eventId);
      if (event) {
        (event as { drop_id: string | null }).drop_id = dropId;
      }
    },
    upsertDropAuthorSignature: async ({
      dropId,
      eventId
    }: {
      dropId: string;
      eventId: string;
    }) => {
      store.authorSignatures.set(dropId, eventId);
    },
    deleteDropAuthorSignature: async (dropId: string) => {
      store.authorSignatures.delete(dropId);
    },
    touchGrantLastUsed: async () => undefined,
    executeNativeQueriesInTransaction: async <T>(
      work: (connection: unknown) => Promise<T>
    ) => work({})
  };
  const identities = {
    getProfileIdByWallet: async (wallet: string) => {
      failIf('getProfileIdByWallet');
      return wallet === TEST_BOT_WALLET
        ? walletProfileId
        : (otherWallets[wallet] ?? null);
    }
  };
  const drops = {
    findWaveIdByDropId: async () => null,
    findDropById: async () => null,
    findWaveByIdOrNull: async () => null
  };
  const writes = new DeviceSignedWritesService(
    db as unknown as DeviceSigningDb,
    identities as unknown as IdentitiesDb,
    drops as unknown as DropsDb,
    now
  );
  const value =
    setting ?? JSON.stringify({ [profileId]: await testBotDeviceKeyEntry() });
  const deps: BotDeviceSignerDeps = { writes, grants: db, identities };
  const signer = new BotDeviceSigner(
    async () => deps,
    () => value,
    now
  );
  return { signer, store, setting: value, deps, writes };
}
