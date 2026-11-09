import { AbiCoder, concat, keccak256, toUtf8Bytes, Wallet } from 'ethers';
import {
  buildE2eeGrantStatement,
  buildE2eeGrantTypedData,
  computeE2eeGrantId,
  E2EE_GRANT_SALT,
  E2eeContractWalletVerifier,
  E2eeDeviceGrant,
  findE2eeGrantProblem,
  normalizeE2eeDeviceGrant,
  verifyE2eeDeviceGrant
} from '@/e2ee/e2ee-grant';
import { e2eeKeyFromSeed } from '@/tests/fixtures/e2ee.fixture';

// Grant v2 (D172) shared vector: the v1 vector's wallet, device key and times
// with the suite set {0x004E}. Clients (web, 6529-core, the Rust client) pin
// the same values.
const WALLET_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEVICE_SEED =
  '0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const ISSUED_AT = 1760270400;
const VERIFY_AT = ISSUED_AT + 3600;
const EXPECTED_GRANT_ID_V2 =
  '0x644ebe12cda087010bf3e47ed0d4d495867f9b5add5247156cc6e7f0cb7b2a88';
const EXPECTED_SIGNATURE_V2 =
  '0x130adfb724a264fed9bebd65c0a4e379fb18f86f1a8239874fb2c68e7a2d3b5d66004f3537b6a8a516eca4476e8c38450a74fb0b714fe6b1619e8382bb8b8b1f1c';

const wallet = new Wallet(WALLET_PRIVATE_KEY);
const device = e2eeKeyFromSeed(DEVICE_SEED);

function aGrant(overrides: Partial<E2eeDeviceGrant> = {}): E2eeDeviceGrant {
  return {
    version: 2,
    wallet: wallet.address.toLowerCase(),
    device_key: device.publicKey,
    ciphersuite: 0x004e,
    ciphersuites: [0x004e],
    issued_at: ISSUED_AT,
    expires_at: Math.floor(ISSUED_AT / 60) * 60 + 15552000,
    origin: 'staging.6529.io',
    ...overrides
  };
}

async function sign(grant: E2eeDeviceGrant): Promise<string> {
  const typedData = buildE2eeGrantTypedData(grant);
  return wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );
}

const noContractWallet: E2eeContractWalletVerifier = {
  hasCode: jest.fn(async () => false),
  isValidSignature: jest.fn(async () => false)
};

describe('E2EE device grant v2 (suite set)', () => {
  it('matches the shared v2 grant id and signature vector', async () => {
    const grant = aGrant();
    expect(computeE2eeGrantId(grant)).toBe(EXPECTED_GRANT_ID_V2);
    expect(await sign(grant)).toBe(EXPECTED_SIGNATURE_V2);
  });

  it('is the EIP-712 digest with domain version 2 and a uint16[] field', () => {
    const grant = aGrant({ ciphersuites: [0x004e, 0x004f] });
    const coder = AbiCoder.defaultAbiCoder();
    const typeHash = (type: string) => keccak256(toUtf8Bytes(type));
    const domainSeparator = keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [
          typeHash('EIP712Domain(string name,string version,bytes32 salt)'),
          keccak256(toUtf8Bytes('6529 Encrypted Messages')),
          keccak256(toUtf8Bytes('2')),
          E2EE_GRANT_SALT
        ]
      )
    );
    // An array is the keccak256 of its elements' 32-byte encodings.
    const suitesHash = keccak256(
      coder.encode(['uint256', 'uint256'], [78, 79])
    );
    const structHash = keccak256(
      coder.encode(
        [
          'bytes32',
          'bytes32',
          'address',
          'bytes32',
          'bytes32',
          'uint64',
          'uint64',
          'bytes32'
        ],
        [
          typeHash(
            'MlsDeviceGrant(string statement,address wallet,bytes32 deviceKey,uint16[] ciphersuites,uint64 issuedAt,uint64 expiresAt,string origin)'
          ),
          keccak256(toUtf8Bytes(buildE2eeGrantStatement(grant))),
          grant.wallet,
          grant.device_key,
          suitesHash,
          grant.issued_at,
          grant.expires_at,
          keccak256(toUtf8Bytes(grant.origin))
        ]
      )
    );
    expect(computeE2eeGrantId(grant)).toBe(
      keccak256(concat(['0x1901', domainSeparator, structHash]))
    );
  });

  it('never shares a digest with the v1 grant of the same fields', () => {
    const v2 = aGrant({ ciphersuite: 0x004f, ciphersuites: [0x004f] });
    const { version: _v, ciphersuites: _s, ...v1 } = v2;
    expect(computeE2eeGrantId(v2)).not.toBe(computeE2eeGrantId(v1));
  });

  it('verifies a valid v2 grant', async () => {
    const grant = aGrant();
    const result = await verifyE2eeDeviceGrant({
      grant,
      signature: await sign(grant),
      nowSeconds: VERIFY_AT,
      contractWalletVerifier: noContractWallet
    });
    expect(result).toEqual({
      ok: true,
      grantId: EXPECTED_GRANT_ID_V2,
      verifiedVia: 'eoa'
    });
  });

  it('rejects a v2 signature presented as another set or as v1', async () => {
    const grant = aGrant();
    const signature = await sign(grant);
    for (const other of [
      aGrant({ ciphersuites: [0x004e, 0x004f] }),
      { ...grant, version: 1 as const, ciphersuites: undefined }
    ]) {
      const normalized = normalizeE2eeDeviceGrant(other);
      const result = await verifyE2eeDeviceGrant({
        grant: normalized,
        signature,
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: noContractWallet
      });
      expect(result.ok).toBe(false);
    }
  });

  it('requires a canonical set with an accepted suite, and its lowest as ciphersuite', () => {
    expect(findE2eeGrantProblem(aGrant(), VERIFY_AT)).toBeNull();
    expect(
      findE2eeGrantProblem(aGrant({ ciphersuites: [0x004e, 4660] }), VERIFY_AT)
    ).toBeNull();
    for (const ciphersuites of [
      [],
      [79, 78],
      [78, 78],
      [1, 2, 3, 4, 5],
      [4660]
    ]) {
      expect(
        findE2eeGrantProblem(
          aGrant({ ciphersuites, ciphersuite: ciphersuites[0] ?? 0 }),
          VERIFY_AT
        )
      ).toBe('ciphersuites');
    }
    expect(
      findE2eeGrantProblem(aGrant({ ciphersuite: 0x004f }), VERIFY_AT)
    ).toBe('ciphersuite');
    expect(
      findE2eeGrantProblem(aGrant({ version: 3 as never }), VERIFY_AT)
    ).toBe('version');
  });

  it('honours v1 grants only for 0x004F', () => {
    const v1 = (ciphersuite: number): E2eeDeviceGrant => ({
      wallet: wallet.address.toLowerCase(),
      device_key: device.publicKey,
      ciphersuite,
      issued_at: ISSUED_AT,
      expires_at: Math.floor(ISSUED_AT / 60) * 60 + 15552000,
      origin: 'staging.6529.io'
    });
    expect(findE2eeGrantProblem(v1(0x004f), VERIFY_AT)).toBeNull();
    expect(findE2eeGrantProblem(v1(0x004e), VERIFY_AT)).toBe('ciphersuite');
  });

  it('normalizes the lowest suite into ciphersuite and drops v2 fields from v1', () => {
    expect(
      normalizeE2eeDeviceGrant(
        aGrant({ ciphersuite: 1, ciphersuites: [78, 79] })
      )
    ).toMatchObject({ version: 2, ciphersuite: 78, ciphersuites: [78, 79] });
    const v1 = normalizeE2eeDeviceGrant({
      ...aGrant(),
      version: 1,
      ciphersuite: 79
    });
    expect(v1).not.toHaveProperty('version');
    expect(v1).not.toHaveProperty('ciphersuites');
  });
});
