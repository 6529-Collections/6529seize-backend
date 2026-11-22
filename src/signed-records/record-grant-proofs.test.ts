import { getAddress, hashMessage, Wallet } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  buildDeviceGrantUrn,
  computeDeviceGrantId,
  DeviceGrantTerms,
  renderDeviceGrantStatement
} from '@/api/device-signing/device-grant-message';
import { RecordGrantProof } from './record-event';
import {
  ContractWalletSignatureCheck,
  GrantProofRecordSource,
  verifyGrantProof,
  verifyGrantProofWithChain
} from './record-grant-proofs';
import { toRecordGrantProof } from './record-grants';
import {
  appGrantFixture,
  grantSource,
  VECTORS,
  VECTOR_GRANT
} from './record-test-fixtures';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';

// A smart-contract wallet: an obviously fake address.
const CONTRACT_WALLET = `0x${'c0'.repeat(20)}`;

/** EIP-1271 that accepts exactly these (chain, wallet, hash, signature). */
function contractAccepting(
  accepted: Parameters<ContractWalletSignatureCheck['isValidSignature']>[0]
): ContractWalletSignatureCheck & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    isValidSignature: async (args) => {
      calls.push(args);
      return (
        args.chainId === accepted.chainId &&
        args.wallet === accepted.wallet &&
        args.hash === accepted.hash &&
        args.signature === accepted.signature
      );
    }
  };
}

// Hardhat's second test account, never a real wallet.
const LOGIN_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ISSUED_AT = '2026-11-22T00:00:00.000Z';

async function loginGrantProof(
  address?: string,
  chainId = 1
): Promise<RecordGrantProof> {
  const signer = new Wallet(LOGIN_PRIVATE_KEY);
  const wallet = address ?? signer.address;
  const terms: DeviceGrantTerms = {
    keyType: 'ed25519',
    deviceKey: VECTORS.inputs.deviceKey,
    scopes: ['post', 'edit', 'delete', 'react'],
    expiresAtSeconds: Date.parse(ISSUED_AT) / 1000 + 180 * 86400
  };
  const message = new SiweMessage({
    scheme: 'http',
    domain: 'localhost:3000',
    address: getAddress(wallet),
    statement: renderDeviceGrantStatement(terms),
    uri: 'http://localhost:3000',
    version: '1',
    chainId,
    nonce: 'n0nce12345',
    issuedAt: ISSUED_AT,
    expirationTime: '2026-11-22T00:05:00.000Z',
    resources: [buildDeviceGrantUrn(terms)]
  }).prepareMessage();
  return {
    id: computeDeviceGrantId(message),
    message,
    wallet_signature: (await signer.signMessage(message)).toLowerCase(),
    chain_id: chainId,
    wallet: wallet.toLowerCase(),
    device_key: terms.deviceKey,
    scopes: [...terms.scopes],
    domain: 'localhost:3000',
    expires_at: terms.expiresAtSeconds * 1000,
    revoked_at: null
  };
}

describe('verifyGrantProof', () => {
  it('accepts an app grant and a sign-in grant signed by their wallets', async () => {
    const { proof, grant } = await appGrantFixture();
    expect(verifyGrantProof(proof)).toEqual({ ok: true, grant });
    const login = await loginGrantProof();
    expect(verifyGrantProof(login)).toEqual({
      ok: true,
      grant: {
        id: login.id,
        wallet: login.wallet,
        deviceKey: login.device_key,
        scopes: login.scopes,
        expiresAt: login.expires_at,
        revokedAt: null
      }
    });
  });

  it('refuses a proof whose stored fields differ from the signed grant', async () => {
    for (const proof of [
      await appGrantFixture(),
      { proof: await loginGrantProof() }
    ].map((it) => it.proof)) {
      const tampered: Partial<RecordGrantProof>[] = [
        { id: `0x${'1'.repeat(64)}` },
        { device_key: `0x${'2'.repeat(64)}` },
        { wallet: `0x${'3'.repeat(40)}` },
        { scopes: ['post', 'edit', 'delete', 'react', 'vote'] },
        { expires_at: proof.expires_at + 60_000 }
      ];
      for (const change of tampered) {
        expect(verifyGrantProof({ ...proof, ...change }).ok).toBe(false);
      }
    }
  });

  it('refuses a signature by another wallet and an edited message', async () => {
    const { proof } = await appGrantFixture();
    const other = await loginGrantProof();
    expect(
      verifyGrantProof({ ...proof, wallet_signature: other.wallet_signature })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('recover') });
    expect(
      verifyGrantProof({
        ...other,
        message: other.message.replace('localhost:3000', 'localhost:3001')
      }).ok
    ).toBe(false);
    expect(verifyGrantProof({ ...proof, extra: 1 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('malformed')
    });
  });

  it('keeps the revocation time 6529.io recorded with the proof', async () => {
    const { proof } = await appGrantFixture();
    expect(verifyGrantProof({ ...proof, revoked_at: 123 })).toMatchObject({
      ok: true,
      grant: { revokedAt: 123 }
    });
  });
});

describe('verifyGrantProofWithChain', () => {
  it('accepts an app grant a contract wallet signed, through EIP-1271 on chain 1', async () => {
    const { proof } = await appGrantFixture({ wallet: CONTRACT_WALLET });
    expect(verifyGrantProof(proof)).toMatchObject({ ok: false });
    const check = contractAccepting({
      chainId: 1,
      wallet: CONTRACT_WALLET,
      hash: proof.id,
      signature: proof.wallet_signature
    });
    expect(await verifyGrantProofWithChain(proof, check)).toMatchObject({
      ok: true,
      grant: { id: proof.id, wallet: CONTRACT_WALLET }
    });
    const refusing = contractAccepting({
      chainId: 1,
      wallet: CONTRACT_WALLET,
      hash: proof.id,
      signature: '0x00'
    });
    expect(await verifyGrantProofWithChain(proof, refusing)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('recover')
    });
  });

  it("checks a sign-in grant's EIP-191 hash on the SIWE chain", async () => {
    const proof = await loginGrantProof(CONTRACT_WALLET, 8453);
    const check = contractAccepting({
      chainId: 8453,
      wallet: CONTRACT_WALLET,
      hash: hashMessage(proof.message),
      signature: proof.wallet_signature
    });
    expect(await verifyGrantProofWithChain(proof, check)).toMatchObject({
      ok: true
    });
  });

  it('asks the chain only for a signature that is not the wallet key, and never for a bad proof', async () => {
    const { proof } = await appGrantFixture();
    const check = contractAccepting({
      chainId: 0,
      wallet: '',
      hash: '',
      signature: ''
    });
    expect(await verifyGrantProofWithChain(proof, check)).toMatchObject({
      ok: true
    });
    expect(
      await verifyGrantProofWithChain({ ...proof, scopes: ['post'] }, check)
    ).toMatchObject({ ok: false, reason: expect.stringContaining('differ') });
    expect(check.calls).toEqual([]);
  });

  it('stops when the chain cannot be read, instead of calling the grant unknown', async () => {
    const { proof } = await appGrantFixture({ wallet: CONTRACT_WALLET });
    const down: ContractWalletSignatureCheck = {
      isValidSignature: () => Promise.reject(new Error('rpc down'))
    };
    await expect(verifyGrantProofWithChain(proof, down)).rejects.toThrow(
      'rpc down'
    );
    await expect(
      GrantProofRecordSource.from([proof], { contractWallets: down })
    ).rejects.toThrow('rpc down');
  });
});

describe('toRecordGrantProof', () => {
  it('carries a long or mixed-case stored signature as lowercase hex the schema takes', async () => {
    const { proof } = await appGrantFixture();
    const long = `0x${'Ab'.repeat(3000)}`;
    const entity = {
      id: proof.id,
      wallet: proof.wallet,
      device_key: proof.device_key,
      scopes: proof.scopes.join(','),
      domain: proof.domain,
      message: proof.message,
      wallet_signature: long,
      chain_id: 1,
      expires_at: proof.expires_at,
      revoked_at: null
    } as unknown as DeviceGrantEntity;
    const carried = toRecordGrantProof(entity);
    expect(carried.wallet_signature).toBe(long.toLowerCase());
    // The shape is fine; only the signature fails to recover.
    expect(verifyGrantProof(carried)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('recover')
    });
  });
});

describe('GrantProofRecordSource', () => {
  it('asks the fallback for a grant no proof verifies', async () => {
    const { proof } = await appGrantFixture({ wallet: CONTRACT_WALLET });
    const source = await GrantProofRecordSource.from([proof], {
      fallback: grantSource([VECTOR_GRANT])
    });
    await expect(source.findGrant(proof.id)).resolves.toBeNull();
    await expect(source.findGrant(VECTOR_GRANT.id)).resolves.toEqual(
      VECTOR_GRANT
    );
  });

  it('knows only the proofs that verify', async () => {
    const { proof, grant } = await appGrantFixture();
    const source = new GrantProofRecordSource([
      proof,
      { ...(await loginGrantProof()), wallet_signature: proof.wallet_signature }
    ]);
    await expect(
      source.findGrant(proof.id.toUpperCase().replace('0X', '0x'))
    ).resolves.toEqual(grant);
    await expect(source.findGrant(`0x${'9'.repeat(64)}`)).resolves.toBeNull();
  });
});
