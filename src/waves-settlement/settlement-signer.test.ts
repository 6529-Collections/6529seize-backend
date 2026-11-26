import {
  getBytes,
  recoverAddress,
  Signature,
  SigningKey,
  TypedDataEncoder,
  Wallet
} from 'ethers';
import { settlementSignerFromEnv, signDigest } from './settlement-signer';

// The well-known first test account of Hardhat and Anvil; it holds nothing.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const DIGEST =
  '0x7c5ea36004851c764c44143b1dcb59679b11c9a68e5f41497f6cf3d480715331';
const CURVE_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);

function signerOf(key: string) {
  const result = settlementSignerFromEnv({ WAVES_SETTLEMENT_SENDER_KEY: key });
  if (!result.ok) throw new Error(`no signer: ${result.problem}`);
  return result.signer;
}

describe('settlement signer', () => {
  it('derives the wallet address from the key', () => {
    expect(signerOf(TEST_KEY).address).toBe(TEST_ADDRESS);
    expect(
      signerOf(`  ${TEST_KEY.toUpperCase().replace('0X', '0x')}\n`)
    ).toEqual(expect.objectContaining({ address: TEST_ADDRESS }));
  });

  it('signs a known digest: 65 bytes, v 27 or 28, low s, recovering to the sender', () => {
    const sig = signerOf(TEST_KEY).sign(DIGEST);
    const bytes = getBytes(sig);
    expect(bytes).toHaveLength(65);
    expect([27, 28]).toContain(bytes[64]);
    expect(BigInt(Signature.from(sig).s) <= CURVE_ORDER / BigInt(2)).toBe(true);
    expect(recoverAddress(DIGEST, sig).toLowerCase()).toBe(TEST_ADDRESS);
  });

  it('signs the digest itself, as eth_signTypedData_v4 does, not a prefixed message', async () => {
    const domain = {
      name: '6529 Network',
      version: '1',
      salt: '0x' + 'ab'.repeat(32)
    };
    const types = {
      SettlementRequestBody: [
        { name: 'decisionId', type: 'bytes32' },
        { name: 'occurrence', type: 'uint32' },
        { name: 'maxEntries', type: 'uint16' }
      ]
    };
    const value = {
      decisionId: '0x' + '01'.repeat(32),
      occurrence: 2,
      maxEntries: 50
    };
    const digest = TypedDataEncoder.hash(domain, types, value);
    const wallet = new Wallet(TEST_KEY);
    expect(signerOf(TEST_KEY).sign(digest)).toBe(
      await wallet.signTypedData(domain, types, value)
    );
    expect(signerOf(TEST_KEY).sign(digest)).not.toBe(
      await wallet.signMessage(getBytes(digest))
    );
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => signDigest(new SigningKey(TEST_KEY), '0x1234')).toThrow(
      'A digest is 0x and 64 hex digits'
    );
  });

  it('reports a missing key', () => {
    expect(settlementSignerFromEnv({})).toEqual({
      ok: false,
      problem: 'missing'
    });
    expect(
      settlementSignerFromEnv({ WAVES_SETTLEMENT_SENDER_KEY: '  ' })
    ).toEqual({ ok: false, problem: 'missing' });
  });

  it.each([
    ['without 0x', TEST_KEY.slice(2)],
    ['too short', TEST_KEY.slice(0, 64)],
    ['not hex', TEST_KEY.slice(0, 65) + 'g'],
    ['zero', '0x' + '00'.repeat(32)],
    ['past the curve order', '0x' + 'ff'.repeat(32)]
  ])('reports a malformed key (%s) without quoting it', (_, key) => {
    const result = settlementSignerFromEnv({
      WAVES_SETTLEMENT_SENDER_KEY: key
    });
    expect(result).toEqual({ ok: false, problem: 'malformed' });
    expect(JSON.stringify(result)).not.toContain(key.slice(4, 20));
  });
});
