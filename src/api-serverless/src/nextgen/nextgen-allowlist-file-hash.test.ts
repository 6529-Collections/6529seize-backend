import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { validateNextgen } from '@/api/nextgen/validation';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  hashStructuredWalletSignaturePayload
} from '@/api/wallet-signatures/structured-wallet-signatures';

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const CSV = Buffer.from(
  [
    '0x0000000000000000000000000000000000000001,2,a',
    '0x0000000000000000000000000000000000000002,1,b'
  ].join('\n')
);
const CSV_SHA256 = createHash('sha256').update(CSV).digest('hex');

const payload = {
  collection_id: 1,
  uuid: '4f0b8f0e-2d7d-4b8e-9f3c-1a2b3c4d5e6f',
  al_type: 'allowlist',
  phase: 'Phase 1',
  start_time: 1700000000,
  end_time: 1700003600,
  mint_price: 0.05
};

async function upload(
  signedPayload: Record<string, unknown>,
  nonce: string,
  file: Buffer = CSV
) {
  const message = buildStructuredWalletSignatureMessage({
    kind: 'action',
    domain: 'example.com',
    wallet: wallet.address,
    nonce,
    action: 'nextgen_admin',
    payloadHash: hashStructuredWalletSignaturePayload(signedPayload),
    purpose: 'Sign this message to perform a 6529 NextGen admin action.'
  });
  const req: any = {
    body: {
      nextgen: JSON.stringify({
        ...signedPayload,
        wallet: wallet.address,
        signature: await wallet.signMessage(message),
        signature_message: message
      })
    },
    file: { originalname: 'allowlist.csv', buffer: file }
  };
  const next = jest.fn();
  await validateNextgen(req, {}, next);
  expect(next).toHaveBeenCalled();
  return req.validatedBody;
}

describe('NextGen allowlist uploads and the signed file hash', () => {
  beforeEach(() => {
    clearStructuredWalletSignatureReplayCacheForTests();
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    jest.spyOn(ethers, 'Contract', 'get').mockReturnValue(
      jest.fn().mockImplementation(() => ({
        retrieveGlobalAdmin: jest.fn().mockResolvedValue(true),
        retrieveFunctionAdmin: jest.fn().mockResolvedValue(false),
        retrieveCollectionAdmin: jest.fn().mockResolvedValue(false)
      })) as unknown as typeof ethers.Contract
    );
  });

  afterEach(() => {
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.FEATURE_NEXTGEN_ALLOWLIST_SIGNED_FILE;
    jest.restoreAllMocks();
  });

  it('accepts the file whose sha256 was signed, and keeps the signed request', async () => {
    const signedPayload = { ...payload, allowlist_sha256: CSV_SHA256 };
    const result = await upload(signedPayload, 'nextgen-hash-1');
    expect(result).toEqual(
      expect.objectContaining({
        valid: true,
        allowlist_sha256: CSV_SHA256,
        signed: expect.objectContaining({
          wallet: wallet.address,
          payload: signedPayload
        })
      })
    );
  });

  it('refuses a file other than the signed one', async () => {
    const result = await upload(
      { ...payload, allowlist_sha256: CSV_SHA256 },
      'nextgen-hash-2',
      Buffer.from('0x0000000000000000000000000000000000000003,5,c')
    );
    expect(result).toEqual({
      valid: false,
      error: 'The allowlist file is not the file that was signed'
    });
  });

  it('still accepts an upload without a signed hash while the flag is off', async () => {
    const result = await upload(payload, 'nextgen-hash-3');
    expect(result).toEqual(
      expect.objectContaining({ valid: true, allowlist_sha256: CSV_SHA256 })
    );
  });

  it('refuses an upload without a signed hash once the flag is on', async () => {
    process.env.FEATURE_NEXTGEN_ALLOWLIST_SIGNED_FILE = 'true';
    const result = await upload(payload, 'nextgen-hash-4');
    expect(result).toEqual({
      valid: false,
      error: 'Sign the allowlist file: the signed payload needs its sha256'
    });
  });
});
