import { Wallet } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  buildDeviceGrantUrn,
  computeDeviceGrantId,
  DeviceGrantTerms,
  renderDeviceGrantStatement
} from '@/api/device-signing/device-grant-message';
import { RecordGrantProof } from './record-event';
import {
  GrantProofRecordSource,
  verifyGrantProof
} from './record-grant-proofs';
import { appGrantFixture, VECTORS } from './record-test-fixtures';

// Hardhat's second test account, never a real wallet.
const LOGIN_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ISSUED_AT = '2026-11-22T00:00:00.000Z';

async function loginGrantProof(): Promise<RecordGrantProof> {
  const signer = new Wallet(LOGIN_PRIVATE_KEY);
  const terms: DeviceGrantTerms = {
    keyType: 'ed25519',
    deviceKey: VECTORS.inputs.deviceKey,
    scopes: ['post', 'edit', 'delete', 'react'],
    expiresAtSeconds: Date.parse(ISSUED_AT) / 1000 + 180 * 86400
  };
  const message = new SiweMessage({
    scheme: 'http',
    domain: 'localhost:3000',
    address: signer.address,
    statement: renderDeviceGrantStatement(terms),
    uri: 'http://localhost:3000',
    version: '1',
    chainId: 1,
    nonce: 'n0nce12345',
    issuedAt: ISSUED_AT,
    expirationTime: '2026-11-22T00:05:00.000Z',
    resources: [buildDeviceGrantUrn(terms)]
  }).prepareMessage();
  return {
    id: computeDeviceGrantId(message),
    message,
    wallet_signature: (await signer.signMessage(message)).toLowerCase(),
    chain_id: 1,
    wallet: signer.address.toLowerCase(),
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

describe('GrantProofRecordSource', () => {
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
