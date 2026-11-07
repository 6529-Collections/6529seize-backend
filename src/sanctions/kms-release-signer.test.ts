import {
  keccak256,
  SigningKey,
  toUtf8Bytes,
  verifyMessage,
  Wallet
} from 'ethers';
import {
  KmsReleaseSigner,
  KmsSigningClient,
  parseDerSignature,
  uncompressedPointFromSpki
} from '@/sanctions/kms-release-signer';

const N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function derSignature(r: bigint, s: bigint): Buffer {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** A stand-in for KMS: signs digests with a local key and returns DER, like KMS. */
function fakeKms(
  privateKey: string,
  options: { highS: boolean }
): KmsSigningClient {
  const key = new SigningKey(privateKey);
  const spkiPrefix = Buffer.from(
    '3056301006072a8648ce3d020106052b8104000a034200',
    'hex'
  );
  return {
    async getPublicKeyDer() {
      return Buffer.concat([
        spkiPrefix,
        Buffer.from(key.publicKey.slice(2), 'hex')
      ]);
    },
    async signDigest(_keyId, digest) {
      const signature = key.sign(digest);
      const r = BigInt(signature.r);
      let s = BigInt(signature.s);
      if (options.highS) {
        s = N - s;
      }
      return derSignature(r, s);
    }
  };
}

const PRIVATE_KEY = keccak256(toUtf8Bytes('6529-sanctions-test-key-1'));
const ADDRESS = new Wallet(PRIVATE_KEY).address.toLowerCase();

describe('KmsReleaseSigner', () => {
  it.each([false, true])(
    'produces EIP-191 signatures that recover to the key address (high s: %p)',
    async (highS) => {
      const signer = await KmsReleaseSigner.create(
        fakeKms(PRIVATE_KEY, { highS }),
        'test-key'
      );
      expect(signer.address).toBe(ADDRESS);
      const message = toUtf8Bytes('{"sequence":1}');
      const signature = await signer.signMessage(message);
      expect(verifyMessage(message, signature).toLowerCase()).toBe(ADDRESS);
      const s = BigInt(`0x${signature.slice(66, 130)}`);
      expect(s <= N / BigInt(2)).toBe(true);
    }
  );

  it('matches a local wallet signature byte for byte', async () => {
    const signer = await KmsReleaseSigner.create(
      fakeKms(PRIVATE_KEY, { highS: false }),
      'test-key'
    );
    const message = toUtf8Bytes('same bytes');
    expect(await signer.signMessage(message)).toBe(
      await new Wallet(PRIVATE_KEY).signMessage(message)
    );
  });
});

describe('DER helpers', () => {
  it('parses r and s, including leading-zero padded integers', () => {
    const r = BigInt('0x80' + '11'.repeat(31));
    const s = BigInt(5);
    expect(parseDerSignature(derSignature(r, s))).toEqual({ r, s });
  });

  it.each([
    ['not a sequence', Buffer.from([0x31, 0x00])],
    ['bad length', Buffer.from([0x30, 0x05, 0x02, 0x01, 0x01])],
    [
      'trailing bytes',
      Buffer.concat([
        derSignature(BigInt(1), BigInt(2)).subarray(0, 2),
        Buffer.from([0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00])
      ])
    ]
  ])('rejects %s', (_label, der) => {
    expect(() => parseDerSignature(der)).toThrow(/Malformed DER/);
  });

  it('refuses a public key that is not an uncompressed point', () => {
    expect(() => uncompressedPointFromSpki(Buffer.alloc(70))).toThrow(
      /uncompressed/
    );
  });
});
