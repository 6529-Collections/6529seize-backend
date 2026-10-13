import { AbiCoder, concat, keccak256, toUtf8Bytes, Wallet } from 'ethers';
import {
  buildE2eeGrantStatement,
  buildE2eeGrantTypedData,
  computeE2eeGrantId,
  E2EE_GRANT_SALT,
  E2eeContractWalletVerifier,
  E2eeDeviceGrant,
  findE2eeGrantProblem,
  formatE2eeGrantExpiry,
  verifyE2eeDeviceGrant
} from '@/e2ee/e2ee-grant';
import { e2eeKeyFromSeed } from '@/tests/fixtures/e2ee.fixture';

// Shared vector (also in the frontend handoff file e2ee-grant-vectors.json).
const WALLET_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEVICE_SEED =
  '0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const ISSUED_AT = 1760270400;
const VERIFY_AT = ISSUED_AT + 3600;
const EXPECTED_STATEMENT =
  'Let this device send and read end-to-end encrypted messages as you until 2026-04-10 12:00 UTC (device key d75a9801...f707511a). 6529 cannot read these messages. This signature cannot move funds, change your handle or act as an admin, and it does not create a blockchain transaction or cost gas.';
const EXPECTED_GRANT_ID =
  '0x071474c69e205b3bb03834c8d99c99b2b826caad6eec914c233e67eaca3b2200';
const EXPECTED_SIGNATURE =
  '0xa280cc8335dfaf00e13a7b6b83a2c7f217398dde4d0649b560b3cb3c5e6a9a665bf3d84f35540243c0f462cedbe96153e00db006627f0a3fe75257c219c495f31b';

const wallet = new Wallet(WALLET_PRIVATE_KEY);
const device = e2eeKeyFromSeed(DEVICE_SEED);

function aGrant(overrides: Partial<E2eeDeviceGrant> = {}): E2eeDeviceGrant {
  return {
    wallet: wallet.address.toLowerCase(),
    device_key: device.publicKey,
    ciphersuite: 1,
    issued_at: ISSUED_AT,
    expires_at: Math.floor(ISSUED_AT / 60) * 60 + 15552000,
    origin: 'staging.6529.io',
    ...overrides
  };
}

async function sign(grant: E2eeDeviceGrant, signer = wallet): Promise<string> {
  const typedData = buildE2eeGrantTypedData(grant);
  return signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );
}

const noContractWallet: E2eeContractWalletVerifier = {
  hasCode: jest.fn(async () => false),
  isValidSignature: jest.fn(async () => false)
};

describe('E2EE device grant', () => {
  it('uses the contract salt', () => {
    expect(E2EE_GRANT_SALT).toBe(
      '0x4887f15a22b96f574a9f835b87e01e293dc7587acbfc13b5f224b89cd2d8c8aa'
    );
  });

  it('matches the shared statement, grant id and signature vector', async () => {
    const grant = aGrant();
    expect(device.publicKey).toBe(
      '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
    );
    expect(grant.expires_at).toBe(1775822400);
    expect(buildE2eeGrantStatement(grant)).toBe(EXPECTED_STATEMENT);
    expect(computeE2eeGrantId(grant)).toBe(EXPECTED_GRANT_ID);
    expect(await sign(grant)).toBe(EXPECTED_SIGNATURE);
  });

  it('computes grant_id as the EIP-712 digest with a salt-only domain', () => {
    const grant = aGrant();
    const coder = AbiCoder.defaultAbiCoder();
    const typeHash = (type: string) => keccak256(toUtf8Bytes(type));
    const domainSeparator = keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [
          typeHash('EIP712Domain(string name,string version,bytes32 salt)'),
          keccak256(toUtf8Bytes('6529 Encrypted Messages')),
          keccak256(toUtf8Bytes('1')),
          E2EE_GRANT_SALT
        ]
      )
    );
    const structHash = keccak256(
      coder.encode(
        [
          'bytes32',
          'bytes32',
          'address',
          'bytes32',
          'uint16',
          'uint64',
          'uint64',
          'bytes32'
        ],
        [
          typeHash(
            'MlsDeviceGrant(string statement,address wallet,bytes32 deviceKey,uint16 ciphersuite,uint64 issuedAt,uint64 expiresAt,string origin)'
          ),
          keccak256(toUtf8Bytes(EXPECTED_STATEMENT)),
          grant.wallet,
          grant.device_key,
          grant.ciphersuite,
          grant.issued_at,
          grant.expires_at,
          keccak256(toUtf8Bytes(grant.origin))
        ]
      )
    );
    expect(keccak256(concat(['0x1901', domainSeparator, structHash]))).toBe(
      EXPECTED_GRANT_ID
    );
  });

  it('formats the expiry in zero-padded UTC', () => {
    expect(formatE2eeGrantExpiry(Date.UTC(2027, 0, 2, 3, 4) / 1000)).toBe(
      '2027-01-02 03:04'
    );
  });

  it('verifies a valid EOA grant', async () => {
    const grant = aGrant();
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature: await sign(grant),
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: noContractWallet
      })
    ).resolves.toEqual({
      ok: true,
      grantId: EXPECTED_GRANT_ID,
      verifiedVia: 'eoa'
    });
  });

  it('rejects a signature over a different statement', async () => {
    const grant = aGrant();
    const typedData = buildE2eeGrantTypedData(grant);
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      { ...typedData.message, statement: `${typedData.message.statement} ` }
    );
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature,
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: noContractWallet
      })
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
  });

  it('rejects a grant signed by another wallet', async () => {
    const grant = aGrant();
    const signature = await sign(grant, Wallet.createRandom() as never);
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature,
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: noContractWallet
      })
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
  });

  it('rejects expired, too long, unaligned and future grants', () => {
    const grant = aGrant();
    expect(findE2eeGrantProblem(grant, grant.expires_at)).toBe('expired');
    expect(
      findE2eeGrantProblem(
        aGrant({ expires_at: ISSUED_AT + 181 * 86400 + 60 }),
        VERIFY_AT
      )
    ).toBe('lifetime');
    expect(
      findE2eeGrantProblem(
        aGrant({ expires_at: ISSUED_AT + 181 * 86400 }),
        VERIFY_AT
      )
    ).toBeNull();
    expect(
      findE2eeGrantProblem(
        aGrant({ expires_at: grant.expires_at + 1 }),
        VERIFY_AT
      )
    ).toBe('expiry_alignment');
    expect(findE2eeGrantProblem(grant, ISSUED_AT - 3600)).toBe(
      'issued_in_future'
    );
    expect(findE2eeGrantProblem(aGrant({ ciphersuite: 2 }), VERIFY_AT)).toBe(
      'ciphersuite'
    );
    expect(findE2eeGrantProblem(aGrant({ origin: '' }), VERIFY_AT)).toBe(
      'origin'
    );
    expect(
      findE2eeGrantProblem(aGrant({ origin: 'x'.repeat(65) }), VERIFY_AT)
    ).toBe('origin');
    expect(
      findE2eeGrantProblem(
        aGrant({ wallet: wallet.address as string }),
        VERIFY_AT
      )
    ).toBe('wallet_format');
  });

  it('verifies a contract wallet through EIP-1271 when EOA recovery fails', async () => {
    const grant = aGrant();
    const verifier: E2eeContractWalletVerifier = {
      hasCode: jest.fn(async () => true),
      isValidSignature: jest.fn(async () => true)
    };
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature: '0x',
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: verifier
      })
    ).resolves.toEqual({
      ok: true,
      grantId: EXPECTED_GRANT_ID,
      verifiedVia: 'eip1271'
    });
    expect(verifier.hasCode).toHaveBeenCalledWith(grant.wallet);
    expect(verifier.isValidSignature).toHaveBeenCalledWith(
      grant.wallet,
      EXPECTED_GRANT_ID,
      '0x'
    );
  });

  it('rejects a contract wallet whose EIP-1271 check fails or errors', async () => {
    const grant = aGrant();
    const rejecting: E2eeContractWalletVerifier = {
      hasCode: async () => true,
      isValidSignature: async () => false
    };
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature: '0x1234',
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: rejecting
      })
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    const failing: E2eeContractWalletVerifier = {
      hasCode: async () => {
        throw new Error('rpc down');
      },
      isValidSignature: async () => true
    };
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature: '0x1234',
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: failing
      })
    ).resolves.toEqual({ ok: false, reason: 'contract_wallet_unavailable' });
  });

  it('does not consult EIP-1271 for a wallet without code', async () => {
    const grant = aGrant();
    const verifier: E2eeContractWalletVerifier = {
      hasCode: jest.fn(async () => false),
      isValidSignature: jest.fn(async () => true)
    };
    await expect(
      verifyE2eeDeviceGrant({
        grant,
        signature: '0xdeadbeef',
        nowSeconds: VERIFY_AT,
        contractWalletVerifier: verifier
      })
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    expect(verifier.isValidSignature).not.toHaveBeenCalled();
  });
});
