import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand
} from '@aws-sdk/client-kms';
import { createPublicKey } from 'crypto';
import {
  computeAddress,
  getBytes,
  hexlify,
  recoverAddress,
  Signature,
  Transaction
} from 'ethers';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

const CURVE_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);

export function decodeKmsSignature(der: Uint8Array): { r: string; s: string } {
  const bytes = Buffer.from(der);
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2 || bytes[2] !== 2)
    throw new LaunchSafetyError('Invalid KMS signature');
  const rLength = bytes[3];
  const sOffset = 4 + rLength;
  const sLength = bytes[sOffset + 1];
  if (bytes[sOffset] !== 2 || sOffset + 2 + sLength !== bytes.length)
    throw new LaunchSafetyError('Invalid KMS signature');
  const parseInteger = (offset: number, length: number) => {
    if (length < 1 || length > 33 || (bytes[offset] & 0x80) !== 0)
      throw new LaunchSafetyError('Invalid KMS signature integer');
    const value = BigInt(hexlify(bytes.subarray(offset, offset + length)));
    if (value <= BigInt(0) || value >= CURVE_ORDER)
      throw new LaunchSafetyError('KMS signature integer out of range');
    return value;
  };
  const r = parseInteger(4, rLength);
  let s = parseInteger(sOffset + 2, sLength);
  if (s > CURVE_ORDER / BigInt(2)) s = CURVE_ORDER - s;
  const padded = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
  return { r: padded(r), s: padded(s) };
}

export class KmsTransactionSigner {
  private verified = false;
  constructor(
    private readonly keyId: string,
    private readonly address: string,
    private readonly client = new KMSClient({
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2000,
        socketTimeout: 10000
      })
    })
  ) {}

  async verify(): Promise<void> {
    if (this.verified) return;
    const key = await this.client.send(
      new GetPublicKeyCommand({ KeyId: this.keyId })
    );
    if (
      key.KeySpec !== 'ECC_SECG_P256K1' ||
      key.KeyUsage !== 'SIGN_VERIFY' ||
      !key.PublicKey
    )
      throw new LaunchSafetyError(
        'KMS key must be ECC_SECG_P256K1 SIGN_VERIFY'
      );
    const jwk = createPublicKey({
      key: Buffer.from(key.PublicKey),
      format: 'der',
      type: 'spki'
    }).export({ format: 'jwk' });
    if (!jwk.x || !jwk.y)
      throw new LaunchSafetyError('KMS public key is invalid');
    const publicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url')
    ]);
    if (
      computeAddress(hexlify(publicKey)).toLowerCase() !==
      this.address.toLowerCase()
    )
      throw new LaunchSafetyError(
        'KMS key does not match the configured signer'
      );
    this.verified = true;
  }

  async sign(unsigned: string): Promise<string> {
    await this.verify();
    const tx = Transaction.from(unsigned);
    if (tx.signature)
      throw new LaunchSafetyError('Expected an unsigned transaction');
    const result = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: getBytes(tx.unsignedHash),
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256'
      })
    );
    if (!result.Signature)
      throw new LaunchSafetyError('KMS returned no signature');
    const { r, s } = decodeKmsSignature(result.Signature);
    for (const yParity of [0, 1] as const) {
      const signature = Signature.from({ r, s, yParity });
      if (
        recoverAddress(tx.unsignedHash, signature).toLowerCase() ===
        this.address.toLowerCase()
      ) {
        tx.signature = signature;
        return tx.serialized;
      }
    }
    throw new LaunchSafetyError(
      'KMS signature did not recover to the configured signer'
    );
  }
}
