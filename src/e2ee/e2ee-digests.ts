import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { AbiCoder, concat, getBytes, keccak256, toUtf8Bytes } from 'ethers';

// Digests of the E2EE contract (D109 v1, sections 1, 2.4, 3 and 4.1).
// H(name, f1..fk) = keccak256(abi.encode(bytes32 TAG(name), f1..fk)) with
// TAG(name) = keccak256(ASCII name). Every field is a static ABI type, so the
// encoding is a concatenation of 32-byte big-endian words.

export const E2EE_ZERO_32 = `0x${'0'.repeat(64)}`;

export const E2EE_DIGEST_NAMES = {
  entry: '6529.MlsEntry.v1',
  roster: '6529.MlsRoster.v1',
  revoke: '6529.MlsDeviceRevoke.v1',
  message: '6529.MlsMessageSig.v1',
  epoch: '6529.MlsEpoch.v1',
  wrapEntry: '6529.MlsWrapE.v1',
  wrapMessage: '6529.MlsWrapM.v1'
} as const;

export enum E2eeEntryKind {
  COMMIT = 1,
  PROPOSAL = 2
}

export type E2eeAbiField =
  | readonly ['bytes32', string]
  | readonly ['uint8' | 'uint32' | 'uint64', number | bigint];

const abiCoder = AbiCoder.defaultAbiCoder();

export function e2eeTag(name: string): string {
  return keccak256(toUtf8Bytes(name));
}

export function e2eeHash(
  name: string,
  fields: readonly E2eeAbiField[]
): string {
  return keccak256(
    abiCoder.encode(
      ['bytes32', ...fields.map(([type]) => type)],
      [e2eeTag(name), ...fields.map(([, value]) => value)]
    )
  );
}

export function keccakBytes(data: Uint8Array): string {
  return keccak256(data);
}

/** fp(x): the first 8 bytes of keccak256(x) as 16 lowercase hex characters. */
export function e2eeFingerprint(data: Uint8Array): string {
  return keccak256(data).slice(2, 18);
}

export interface E2eeEntryDigestInput {
  readonly group: string;
  readonly epoch: number;
  readonly kind: E2eeEntryKind;
  readonly entryHash: string;
  readonly epochCommitment: string;
  readonly nextCommitKey: string;
  readonly paddedLen: number;
}

export function e2eeEntryDigest(input: E2eeEntryDigestInput): string {
  return e2eeHash(E2EE_DIGEST_NAMES.entry, [
    ['bytes32', input.group],
    ['uint32', input.epoch],
    ['uint8', input.kind],
    ['bytes32', input.entryHash],
    ['bytes32', input.epochCommitment],
    ['bytes32', input.nextCommitKey],
    ['uint32', input.paddedLen]
  ]);
}

/** Device keys sorted as 32-byte values (lowercase hex sorts the same way). */
export function e2eeSortedDeviceKeys(deviceKeys: readonly string[]): string[] {
  return [...deviceKeys]
    .map((key) => key.toLowerCase())
    .sort((a, b) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
}

export function e2eeRosterDigest(input: {
  readonly group: string;
  readonly epoch: number;
  readonly deviceKeys: readonly string[];
}): string {
  const sorted = e2eeSortedDeviceKeys(input.deviceKeys);
  const rosterHash = keccak256(
    sorted.length ? concat(sorted.map((key) => getBytes(key))) : '0x'
  );
  return e2eeHash(E2EE_DIGEST_NAMES.roster, [
    ['bytes32', input.group],
    ['uint32', input.epoch],
    ['bytes32', rosterHash]
  ]);
}

export function e2eeRevokeDigest(input: {
  readonly targetDeviceKey: string;
  readonly revokerDeviceKey: string;
  readonly revokedAtSeconds: number;
}): string {
  return e2eeHash(E2EE_DIGEST_NAMES.revoke, [
    ['bytes32', input.targetDeviceKey],
    ['bytes32', input.revokerDeviceKey],
    ['uint64', input.revokedAtSeconds]
  ]);
}

export function e2eeMessageDigest(input: {
  readonly group: string;
  readonly epoch: number;
  readonly body: Uint8Array;
}): string {
  return e2eeHash(E2EE_DIGEST_NAMES.message, [
    ['bytes32', input.group],
    ['uint32', input.epoch],
    ['bytes32', keccak256(input.body)]
  ]);
}

export function e2eeEpochCommitment(input: {
  readonly group: string;
  readonly epoch: number;
  readonly groupContextHash: string;
}): string {
  return e2eeHash(E2EE_DIGEST_NAMES.epoch, [
    ['bytes32', input.group],
    ['uint32', input.epoch],
    ['bytes32', input.groupContextHash]
  ]);
}

export function e2eeEntryWrapAad(input: {
  readonly group: string;
  readonly epoch: number;
  readonly kind: E2eeEntryKind;
}): string {
  return e2eeHash(E2EE_DIGEST_NAMES.wrapEntry, [
    ['bytes32', input.group],
    ['uint32', input.epoch],
    ['uint8', input.kind]
  ]);
}

export function e2eeMessageWrapAad(input: {
  readonly group: string;
  readonly epoch: number;
}): string {
  return e2eeHash(E2EE_DIGEST_NAMES.wrapMessage, [
    ['bytes32', input.group],
    ['uint32', input.epoch]
  ]);
}

/**
 * Pure Ed25519 (RFC 8032) verification of `signature` (0x + 128 hex) over the
 * 32 raw bytes of `digest` with the raw public key `publicKey` (0x + 64 hex).
 * Malformed inputs verify as false.
 */
export function verifyE2eeEd25519(
  publicKey: string,
  digest: string,
  signature: string
): boolean {
  try {
    const keyBytes = Buffer.from(getBytes(publicKey));
    const signatureBytes = Buffer.from(getBytes(signature));
    const message = Buffer.from(getBytes(digest));
    if (
      keyBytes.length !== 32 ||
      signatureBytes.length !== 64 ||
      message.length !== 32
    ) {
      return false;
    }
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: keyBytes.toString('base64url') },
      format: 'jwk'
    });
    return verifySignature(null, message, key, signatureBytes);
  } catch {
    return false;
  }
}
