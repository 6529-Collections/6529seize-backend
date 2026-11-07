import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand
} from '@aws-sdk/client-kms';
import { computeAddress, hashMessage, recoverAddress, Signature } from 'ethers';
import type { SanctionsReleaseSigner } from '@/sanctions/sanctions-release';

/** secp256k1 group order, for low-s normalization (EIP-2). */
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);
const HALF_N = SECP256K1_N / BigInt(2);

/** The minimal KMS surface the signer needs; injectable for tests. */
export interface KmsSigningClient {
  getPublicKeyDer(keyId: string): Promise<Uint8Array>;
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export function awsKmsSigningClient(region: string): KmsSigningClient {
  const client = new KMSClient({ region });
  return {
    async getPublicKeyDer(keyId) {
      const response = await client.send(
        new GetPublicKeyCommand({ KeyId: keyId })
      );
      if (!response.PublicKey || response.KeySpec !== 'ECC_SECG_P256K1') {
        throw new Error('KMS key is not an ECC_SECG_P256K1 signing key');
      }
      return response.PublicKey;
    },
    async signDigest(keyId, digest) {
      const response = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256'
        })
      );
      if (!response.Signature) {
        throw new Error('KMS returned no signature');
      }
      return response.Signature;
    }
  };
}

/** The uncompressed secp256k1 point at the end of a DER SubjectPublicKeyInfo. */
export function uncompressedPointFromSpki(der: Uint8Array): string {
  if (der.length < 65 || der[der.length - 65] !== 0x04) {
    throw new Error('Public key is not an uncompressed secp256k1 point');
  }
  return `0x${Buffer.from(der.subarray(der.length - 65)).toString('hex')}`;
}

function readDerInteger(
  der: Uint8Array,
  offset: number
): { value: bigint; next: number } {
  if (der[offset] !== 0x02) {
    throw new Error('Malformed DER signature: expected INTEGER');
  }
  const length = der[offset + 1];
  const start = offset + 2;
  const end = start + length;
  if (length === 0 || end > der.length) {
    throw new Error('Malformed DER signature: bad INTEGER length');
  }
  const hex = Buffer.from(der.subarray(start, end)).toString('hex');
  return { value: BigInt(`0x${hex}`), next: end };
}

/** Parses an ASN.1 DER ECDSA signature `SEQUENCE { r INTEGER, s INTEGER }`. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) {
    throw new Error('Malformed DER signature: expected SEQUENCE');
  }
  const r = readDerInteger(der, 2);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) {
    throw new Error('Malformed DER signature: trailing bytes');
  }
  return { r: r.value, s: s.value };
}

function toHex32(value: bigint): string {
  let hex = value.toString(16);
  while (hex.length < 64) {
    hex = `0${hex}`;
  }
  return `0x${hex}`;
}

/**
 * An EIP-191 `personal_sign` signer backed by an AWS KMS secp256k1 key. The
 * private key never leaves KMS. Signatures are normalized to low-s and given
 * the recovery id that reproduces the key's address, so any Ethereum tool can
 * verify them.
 */
export class KmsReleaseSigner implements SanctionsReleaseSigner {
  private constructor(
    private readonly kms: KmsSigningClient,
    private readonly keyId: string,
    readonly address: string,
    readonly publicKey: string
  ) {}

  static async create(
    kms: KmsSigningClient,
    keyId: string
  ): Promise<KmsReleaseSigner> {
    const publicKey = uncompressedPointFromSpki(
      await kms.getPublicKeyDer(keyId)
    );
    return new KmsReleaseSigner(
      kms,
      keyId,
      computeAddress(publicKey).toLowerCase(),
      publicKey
    );
  }

  async signMessage(message: Uint8Array): Promise<string> {
    const digest = hashMessage(message);
    const der = await this.kms.signDigest(
      this.keyId,
      Buffer.from(digest.slice(2), 'hex')
    );
    const { r } = parseDerSignature(der);
    let { s } = parseDerSignature(der);
    if (s > HALF_N) {
      s = SECP256K1_N - s;
    }
    for (const v of [27, 28]) {
      const signature = Signature.from({ r: toHex32(r), s: toHex32(s), v });
      if (recoverAddress(digest, signature).toLowerCase() === this.address) {
        return signature.serialized;
      }
    }
    throw new Error('KMS signature does not recover to the key address');
  }
}
