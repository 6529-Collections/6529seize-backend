import { createPrivateKey, KeyObject } from 'node:crypto';
import type { SignedRecordEvent } from './record-event';
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

export class MemoryHeadStore implements RecordHeadStore {
  readonly heads = new Map<string, RecordOrderKey>();

  private static id(key: RecordHeadKey): string {
    return `${key.owner}|${key.family}|${key.type}|${key.key}`;
  }

  async get(key: RecordHeadKey): Promise<RecordOrderKey | null> {
    return this.heads.get(MemoryHeadStore.id(key)) ?? null;
  }

  async put(key: RecordHeadKey, order: RecordOrderKey): Promise<void> {
    this.heads.set(MemoryHeadStore.id(key), order);
  }
}
