import { generateKeyPairSync } from 'crypto';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { getBytes, hexlify, SigningKey, Transaction } from 'ethers';
import {
  decodeKmsSignature,
  KmsTransactionSigner
} from '@/drop-forge/kms-signer';

function encodeInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}
function der(r: bigint, s: bigint): Buffer {
  const integers = Buffer.concat([encodeInteger(r), encodeInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, integers.length]), integers]);
}
describe('KMS transaction signer', () => {
  afterEach(() => jest.restoreAllMocks());
  it('signs the Keccak digest without rehashing and recovers a canonical low-s signature', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const key = new SigningKey(
      hexlify(
        Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url')
      )
    );
    const tx = Transaction.from({
      type: 2,
      chainId: 11155111,
      nonce: 7,
      to: '0x' + '33'.repeat(20),
      data: '0x1234',
      gasLimit: 50000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 1,
      value: 0
    });
    const sig = key.sign(tx.unsignedHash);
    const order = BigInt(
      '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    );
    const send = jest
      .spyOn(KMSClient.prototype, 'send')
      .mockResolvedValueOnce({
        KeySpec: 'ECC_SECG_P256K1',
        KeyUsage: 'SIGN_VERIFY',
        PublicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
      } as never)
      .mockResolvedValueOnce({
        Signature: der(BigInt(sig.r), order - BigInt(sig.s))
      } as never);
    const { computeAddress } = await import('ethers');
    const address = computeAddress(key.publicKey);
    const result = Transaction.from(
      await new KmsTransactionSigner('key', address).sign(tx.unsignedSerialized)
    );
    expect(result.from).toBe(address);
    expect(result.unsignedHash).toBe(tx.unsignedHash);
    expect(result.signature?.s).toBe(sig.s);
    const command = send.mock.calls[1][0] as SignCommand;
    expect(command.input).toMatchObject({
      KeyId: 'key',
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256'
    });
    expect(Array.from(command.input.Message!)).toEqual(
      Array.from(getBytes(tx.unsignedHash))
    );
  });
  it('refuses a key for a different wallet before invoking Sign', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const send = jest.spyOn(KMSClient.prototype, 'send').mockResolvedValue({
      KeySpec: 'ECC_SECG_P256K1',
      KeyUsage: 'SIGN_VERIFY',
      PublicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
    } as never);
    await expect(
      new KmsTransactionSigner('key', '0x' + '55'.repeat(20)).verify()
    ).rejects.toThrow('does not match');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('encodes small signature integers as exactly 32 bytes', () => {
    expect(decodeKmsSignature(der(BigInt(1), BigInt(2)))).toEqual({
      r: '0x' + '0'.repeat(63) + '1',
      s: '0x' + '0'.repeat(63) + '2'
    });
  });
  it.each([
    Buffer.from([]),
    Buffer.from([0x30, 0, 2, 32]),
    der(BigInt(0), BigInt(1)),
    der(BigInt(1), BigInt(0))
  ])('rejects malformed or zero-valued signatures', (bytes) => {
    expect(() => decodeKmsSignature(bytes)).toThrow();
  });
});
