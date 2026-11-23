import { createPrivateKey, KeyObject } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  serializeAppDeviceGrantMessage
} from '@/api/device-signing/app-device-grant';
import { RequestContext } from '@/request.context';
import {
  RecordGrantProof,
  RecordToSign,
  SignedRecordEvent,
  signRecordEvent
} from './record-event';
import type {
  PrincipalBindingSource,
  RecordGrantSource,
  VerifiedGrant
} from './record-verify';
import type { RecordHeadKey, RecordHeadStore } from './record-index';
import type { RecordOrderKey } from './record-order';
import VECTORS_JSON from './vectors/signed-records-v1.json';

interface VectorsFile {
  readonly rfc9180A1: Record<string, string>;
  readonly inputs: Record<string, string>;
  readonly followRecord: SignedRecordEvent;
  readonly followUnset: SignedRecordEvent;
  readonly sealedSettings: {
    readonly event: SignedRecordEvent;
    readonly c: string;
    readonly aesKey: string;
    readonly itemsJson: string;
  };
  readonly keys: {
    readonly event: SignedRecordEvent;
    readonly wrapInfo: string;
    readonly enc: string;
    readonly ct: string;
  };
}

export const VECTORS = VECTORS_JSON as unknown as VectorsFile;

export const hexBytes = (hex: string): Buffer =>
  Buffer.from(hex.replace(/^0x/, ''), 'hex');

const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

/** The vectors' device key (RFC 8032 test 1). */
export function vectorDeviceKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      hexBytes(VECTORS.inputs.ed25519Seed)
    ]),
    format: 'der',
    type: 'pkcs8'
  });
}

export const VECTOR_GRANT: VerifiedGrant = {
  id: VECTORS.inputs.authRef,
  wallet: VECTORS.inputs.author,
  deviceKey: VECTORS.inputs.deviceKey,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAt: Date.UTC(2027, 4, 1),
  revokedAt: null
};

export function grantSource(
  grants: readonly VerifiedGrant[]
): RecordGrantSource {
  return {
    findGrant: async (id) => grants.find((grant) => grant.id === id) ?? null
  };
}

/** Binds wallets to principals from a height on. */
export function bindingSource(
  bindings: readonly { wallet: string; principal: string; from: number }[]
): PrincipalBindingSource {
  return {
    principalAt: async (wallet, height) =>
      bindings.find(
        (binding) =>
          binding.wallet === wallet.toLowerCase() && height >= binding.from
      )?.principal ?? null
  };
}

/** Heads in memory; transactions are no-ops (tests run one ingest at a time). */
export class MemoryHeadStore implements RecordHeadStore {
  readonly heads = new Map<string, RecordOrderKey>();
  transactions = 0;

  private static id(key: RecordHeadKey): string {
    return `${key.owner}|${key.family}|${key.type}|${key.key}`;
  }

  async lock(key: RecordHeadKey): Promise<RecordOrderKey | null> {
    return this.heads.get(MemoryHeadStore.id(key)) ?? null;
  }

  async read(key: RecordHeadKey): Promise<RecordOrderKey | null> {
    return this.heads.get(MemoryHeadStore.id(key)) ?? null;
  }

  async put(key: RecordHeadKey, order: RecordOrderKey): Promise<void> {
    this.heads.set(MemoryHeadStore.id(key), order);
  }

  async inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T> {
    this.transactions++;
    return fn(ctx);
  }
}

// Hardhat's first test account, never a real wallet (as the app grant tests).
const APP_GRANT_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * A real app grant for the vectors' device key, signed by a test wallet,
 * and its proof as the log and the relays carry it.
 */
export async function appGrantFixture(
  overrides: Partial<AppDeviceGrant> = {}
): Promise<{ proof: RecordGrantProof; grant: VerifiedGrant }> {
  const signer = new Wallet(APP_GRANT_PRIVATE_KEY);
  const appGrant: AppDeviceGrant = {
    version: 2,
    wallet: signer.address.toLowerCase(),
    device_key: VECTORS.inputs.deviceKey,
    scopes: ['post', 'edit', 'delete', 'react'],
    mls_device_key: null,
    ciphersuite: null,
    ciphersuites: [],
    issued_at: 1792324800,
    expires_at: 1807876800,
    origin: '6529 Desktop',
    ...overrides
  };
  const message = buildAppDeviceGrantMessage(appGrant);
  const signature = await signer.signTypedData(
    APP_DEVICE_GRANT_DOMAIN_V2,
    APP_DEVICE_GRANT_TYPES_V2,
    message
  );
  const proof: RecordGrantProof = {
    id: computeAppDeviceGrantId(message),
    message: serializeAppDeviceGrantMessage(message),
    wallet_signature: signature.toLowerCase(),
    chain_id: 1,
    wallet: appGrant.wallet,
    device_key: appGrant.device_key,
    scopes: [...appGrant.scopes],
    domain: appGrant.origin,
    expires_at: appGrant.expires_at * 1000,
    revoked_at: null
  };
  return {
    proof,
    grant: {
      id: proof.id,
      wallet: proof.wallet,
      deviceKey: proof.device_key,
      scopes: proof.scopes,
      expiresAt: proof.expires_at,
      revokedAt: null
    }
  };
}

/** A record signed by the vectors' device key under a given grant. */
export function signedRecord(
  grant: Pick<VerifiedGrant, 'id' | 'wallet'>,
  record: Omit<RecordToSign, 'author' | 'deviceKey' | 'authRef'>
): SignedRecordEvent {
  return signRecordEvent(
    {
      ...record,
      author: grant.wallet,
      deviceKey: VECTORS.inputs.deviceKey,
      authRef: grant.id
    },
    vectorDeviceKey()
  );
}
